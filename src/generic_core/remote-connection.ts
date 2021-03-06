/// <reference path='../../third_party/typings/index.d.ts' />

/**
 * remote-connection.ts
 *
 * This file defines a class for a direct remote connection to another machine.
 * It handles the signaling channel between two peers, regardless of permission.
 */

import bridge = require('../lib/bridge/bridge');
import constants = require('./constants');
import globals = require('./globals');
import logging = require('../lib/logging/logging');
import net = require('../lib/net/net.types');
import peerconnection = require('../lib/webrtc/peerconnection');
import rc4 = require('../lib/transformers/rc4');
import rtc_to_net = require('../lib/rtc-to-net/rtc-to-net');
import social = require('../interfaces/social');
import socks_to_rtc = require('../lib/socks-to-rtc/socks-to-rtc');
import tcp = require('../lib/net/tcp');
import uproxy_core_api = require('../interfaces/uproxy_core_api');

declare var freedom: freedom.FreedomInModuleEnv;

var PROXYING_SESSION_ID_LENGTH = 16;

// Generates a string of random letters suitable for use a proxying session ID.
var generateProxyingSessionId_ = (): string => {
  // Generates a random number between 97 and 122 inclusive, corresponding
  // to lowercase a and z:
  //  http://unicode.org/charts/PDF/U0000.pdf
  var a = 97, b = 122;
  var randomCharCode = (): number => {
    // TODO: use crypto, but that requires vulcanize to play with third_party
    return a + (Math.floor(Math.random() * (b - a)));
  };
  var letters: string[] = [];
  for (var i = 0; i < PROXYING_SESSION_ID_LENGTH; i++) {
    letters.push(String.fromCharCode(randomCharCode()));
  }
  return letters.join('');
}

// module Core {
  var log :logging.Log = new logging.Log('remote-connection');

  export class RemoteConnection {

    public localGettingFromRemote = social.GettingState.NONE;
    public localSharingWithRemote = social.SharingState.NONE;

    private bytesSent_ :number = 0;
    private bytesReceived_ :number = 0;

    private socksToRtc_ :socks_to_rtc.SocksToRtc = null;
    private rtcToNet_ :rtc_to_net.RtcToNet = null;

    private isUpdatePending_ = false;

    // Resolve this promise when rtcToNet is created and therefore not null.
    // Used to help determine when to call handleSignal (which relies
    // on rtcToNet or socksToRtc being not null).
    // The promise is reset in resetSharerCreated().
    public onceSharerCreated :Promise<void> = null;
    // Helper function used to fulfill onceSharerCreated.
    private fulfillRtcToNetCreated_ :Function;
    private sharingReset_ :Promise<void> = null;

    // TODO: set up a better type for this
    private sendUpdate_ :(x :uproxy_core_api.Update, data?:Object) => void;

    public activeEndpoint :net.Endpoint = null;

    // Unique ID of the most recent proxying attempt.
    private proxyingId_: string;

    constructor(
      sendUpdate :(x :uproxy_core_api.Update, data?:Object) => void,
      private userId_?:string,
      private portControl_?:freedom.PortControl.PortControl
    ) {
      this.sendUpdate_ = sendUpdate;
      this.resetSharerCreated();
    }

    private createSender_ = (type :social.PeerMessageType) => {
      return (signal :bridge.SignallingMessage) => {
        this.sendUpdate_(uproxy_core_api.Update.SIGNALLING_MESSAGE, {
          type: type,
          data: signal
        });
      }
    }

    // Handles signals received on the signalling channel from the remote peer.
    public handleSignal = (message:social.PeerMessage) :Promise<void> => {
      // TODO: forward messages from pre-bridge clients
      if ((<any>message.data).signals !== undefined) {
        return this.forwardSignal_(message.type, message.data);
      } else {
        return this.handleMetadataSignal_(
            <social.SignallingMetadata>message.data);
      }
    }

    private handleMetadataSignal_ = (
        message:social.SignallingMetadata) :Promise<void> => {
      if (message.proxyingId) {
        log.info('proxying session %1 initiated by remote peer', message.proxyingId);
        this.proxyingId_ = message.proxyingId;
      }
      return Promise.resolve<void>();
    }

    // Forwards a signalling message to the RemoteConnection.
    private forwardSignal_ = (
        type:social.PeerMessageType,
        signal:Object)
        :Promise<void> => {
      if (social.PeerMessageType.SIGNAL_FROM_CLIENT_PEER === type
          && this.rtcToNet_) {
        this.rtcToNet_.handleSignalFromPeer(signal);
      } else if (social.PeerMessageType.SIGNAL_FROM_SERVER_PEER === type
                 && this.socksToRtc_) {
        this.socksToRtc_.handleSignalFromPeer(signal);
      } else {
        log.warn('Invalid signal: ', social.PeerMessageType[type]);
        return;
      }
    };

    public startShare = (remoteVersion:number) :Promise<void> => {
      if (this.rtcToNet_) {
        log.error('rtcToNet_ already exists');
        throw new Error('rtcToNet_ already exists');
      }

      var config :freedom.RTCPeerConnection.RTCConfiguration = {
        iceServers: globals.settings.stunServers
      };

      var pc: peerconnection.PeerConnection<Object>;
      if (remoteVersion < 2) {
        log.debug('peer is running client version 1, using old peerconnection');
        pc = new peerconnection.PeerConnectionClass(
          freedom['core.rtcpeerconnection'](config),
          'rtctonet');
      } else {
        log.debug('peer is running client version >1, using bridge');
        pc = bridge.best('rtctonet', config, this.portControl_);
      }

      this.rtcToNet_ = new rtc_to_net.RtcToNet(this.userId_);
      this.rtcToNet_.start({
        allowNonUnicast: globals.settings.allowNonUnicast,
        reproxy: globals.settings.reproxy,
      }, pc);

      this.rtcToNet_.signalsForPeer.setSyncHandler(this.createSender_(social.PeerMessageType.SIGNAL_FROM_SERVER_PEER));
      this.rtcToNet_.bytesReceivedFromPeer.setSyncHandler(this.handleBytesReceived_);
      this.rtcToNet_.bytesSentToPeer.setSyncHandler(this.handleBytesSent_);
      this.rtcToNet_.statusUpdates.setSyncHandler(this.handleStatusUpdate_);

      this.sharingReset_ = this.rtcToNet_.onceStopped.then(() => {
        this.localSharingWithRemote = social.SharingState.NONE;
        this.sendUpdate_(uproxy_core_api.Update.STOP_GIVING);
        this.rtcToNet_ = null;
        this.bytesSent_ = 0;
        this.bytesReceived_ = 0;
        this.stateRefresh_();
      });

      this.localSharingWithRemote = social.SharingState.TRYING_TO_SHARE_ACCESS;
      this.stateRefresh_();
      this.fulfillRtcToNetCreated_();

      this.rtcToNet_.onceReady.then(() => {
        this.localSharingWithRemote = social.SharingState.SHARING_ACCESS;
        this.sendUpdate_(uproxy_core_api.Update.START_GIVING);
        this.stateRefresh_();
      }).catch((e) => {
        this.stopShare();
      });

      return this.rtcToNet_.onceReady;
    }

    // This *must* be called if you receive an OFFER signal while there is an existing
    // rtcToNet_ instance. Right before you stop the existing instance, make a call to
    // this function so that CANDIDATEs received after the new OFFER will know to wait
    // for a new rtcToNet_ instance to be created. Otherwise, CANDIDATE signals can be
    // dropped or handled by old rtcToNet_ instances.
    public resetSharerCreated = () :void => {
      this.onceSharerCreated = new Promise<void>((F, R) => {
        this.fulfillRtcToNetCreated_ = F;
      });
    }

    public stopShare = () :Promise<void> => {
      if (this.localSharingWithRemote === social.SharingState.NONE) {
        log.warn('Cannot stop sharing when neither sharing nor trying to share.');
        return Promise.resolve<void>();
      }

      this.localSharingWithRemote = social.SharingState.NONE;
      this.stateRefresh_();
      this.rtcToNet_.stop();
      return this.sharingReset_;
    }

    public startGet = (remoteVersion:number) :Promise<net.Endpoint> => {
      if (this.localGettingFromRemote !== social.GettingState.NONE) {
        // This should not happen. If it does, something else is broken. Still, we
        // continue to actually proxy through the instance.
        log.error('Currently have a connection open');
        throw new Error('Currently have a connection open');
      }

      // TODO: sync properly between the extension and the app on proxy settings
      // rather than this cooincidentally the same data.
      if (null != this.socksToRtc_) {
        log.error('socksToRtc_ already exists');
        throw new Error('socksToRtc_ already exists');
      }

      this.proxyingId_ = generateProxyingSessionId_();
      log.info('initiating proxying session %1', this.proxyingId_);

      // Send the proxying session ID to the remote peer.
      var signal :social.SignallingMetadata = {
        proxyingId: this.proxyingId_
      }
      this.sendUpdate_(uproxy_core_api.Update.SIGNALLING_MESSAGE, {
        type: social.PeerMessageType.SIGNAL_FROM_CLIENT_PEER,
        data: signal
      });

      this.socksToRtc_ = new socks_to_rtc.SocksToRtc();

      this.socksToRtc_.bytesReceivedFromPeer.setSyncHandler(this.handleBytesReceived_);
      this.socksToRtc_.bytesSentToPeer.setSyncHandler(this.handleBytesSent_);

      // TODO: Change this back to listening to the 'stopped' callback
      // once https://github.com/uProxy/uproxy/issues/1264 is resolved.
      // Currently socksToRtc's 'stopped' callback does not get called on
      // Firefox, possibly due to issues cleaning up sockets.
      // onceStopping_, unlike 'stopped', gets fired as soon as stopping begins
      // and doesn't wait for all cleanup to finish
      this.socksToRtc_['onceStopping_'].then(() => {
        // Stopped event is only considered an error if the user had been
        // getting access and we hadn't called this.socksToRtc_.stop
        // If there is an error when trying to start proxying, and a stopped
        // event is fired, an error will be displayed as a result of the start
        // promise rejecting.
        // TODO: consider removing error field from STOP_GETTING_FROM_FRIEND
        // The UI should know whether it was a user-initiated stopped event
        // or not (based on whether they clicked stop/logout, or based on
        // whether the browser's proxy was set).

        var isError = social.GettingState.GETTING_ACCESS === this.localGettingFromRemote;
        this.sendUpdate_(uproxy_core_api.Update.STOP_GETTING, isError);

        this.localGettingFromRemote = social.GettingState.NONE;
        this.bytesSent_ = 0;
        this.bytesReceived_ = 0;
        this.stateRefresh_();
        this.socksToRtc_ = null;
        this.activeEndpoint = null;
      });

      this.localGettingFromRemote = social.GettingState.TRYING_TO_GET_ACCESS;
      this.stateRefresh_();

      var tcpServer = new tcp.Server({
        address: '127.0.0.1',
        port: 0
      });

      var config :freedom.RTCPeerConnection.RTCConfiguration = {
        iceServers: globals.settings.stunServers
      };

      var pc: peerconnection.PeerConnection<Object>;

      var localVersion = globals.effectiveMessageVersion();
      var commonVersion = Math.min(localVersion, remoteVersion);
      log.info('lowest shared client version is %1 (me: %2, peer: %3)',
          commonVersion, localVersion, remoteVersion);
      // See globals.ts for a description of each version.
      switch (commonVersion) {
        case constants.MESSAGE_VERSIONS.PRE_BRIDGE:
          log.debug('using old peerconnection');
          pc = new peerconnection.PeerConnectionClass(
            freedom['core.rtcpeerconnection'](config),
            'sockstortc');
          break;
        case constants.MESSAGE_VERSIONS.BRIDGE:
          log.debug('using bridge without obfuscation');
          pc = bridge.preObfuscation('sockstortc', config, this.portControl_);
          break;
        case constants.MESSAGE_VERSIONS.CAESAR:
          log.debug('using bridge with caesar obfuscation');
          pc = bridge.basicObfuscation('sockstortc', config, this.portControl_);
          break;
        case constants.MESSAGE_VERSIONS.HOLOGRAPHIC_ICE:
        case constants.MESSAGE_VERSIONS.ENCRYPTED_SIGNALS:
          // Since nothing changed at the peerconnection layer between
          // HOLOGRAPHIC_ICE and ENCRYPTED_SIGNALS, we can safely
          // fall through.
          log.debug('using holographic ICE with caesar obfuscation');
          pc = bridge.holographicIceOnly('sockstortc', config, this.portControl_);
          break;
        default:
          log.debug('using holographic ICE with RC4 obfuscation');
          pc = bridge.holographicIceOnly('sockstortc', config, this.portControl_, {
            name: 'rc4',
            config: JSON.stringify(rc4.randomConfig())
          });
        }

        globals.metrics.increment('attempt');

      const start = this.socksToRtc_.start(tcpServer, pc).then((endpoint :net.Endpoint) => {
        log.info('SOCKS proxy listening on %1', endpoint);
        this.localGettingFromRemote = social.GettingState.GETTING_ACCESS;
        globals.metrics.increment('success');
        this.stateRefresh_();
        this.activeEndpoint = endpoint;
        return endpoint;
      }).catch((e :Error) => {
        this.localGettingFromRemote = social.GettingState.NONE;
        this.stateRefresh_();
        return Promise.reject(Error('Could not start proxy'));
      });

      // Ugh, this needs to be called after start.
      this.socksToRtc_.signalsForPeer.setSyncHandler(
          this.createSender_(social.PeerMessageType.SIGNAL_FROM_CLIENT_PEER));

      return start;
    }

    public stopGet = () :Promise<void> => {
      if (this.localGettingFromRemote === social.GettingState.NONE) {
        log.warn('Cannot stop proxying when neither proxying nor trying to proxy.');
        return;
      }
      globals.metrics.increment('stop');
      this.localGettingFromRemote = social.GettingState.NONE;
      this.stateRefresh_();
      return this.socksToRtc_.stop();
    }

    /*
     * This handles doing a delayed call to the stateRefresh_ function for any
     * updates we expect to be extremely common but do not need immediate
     * information about (i.e. bytes sent/received).  The update is delayed by
     * a second and we will not do any other updates in the meantime.
     */
    private delayedUpdate_ = () => {
      if (!this.isUpdatePending_) {
        setTimeout(() => {
          this.stateRefresh_();
          this.isUpdatePending_ = false;
        }, 1000);
        this.isUpdatePending_ = true;
      }
    }

    private handleBytesReceived_ = (bytes :number) => {
      this.bytesReceived_ += bytes;
      this.delayedUpdate_();
    }

    private handleBytesSent_ = (bytes :number) => {
      this.bytesSent_ += bytes;
      this.delayedUpdate_();
    }

    private handleStatusUpdate_ = (status :rtc_to_net.Status) => {
      switch(status) {
        case rtc_to_net.Status.REPROXY_ERROR:
          this.sendUpdate_(uproxy_core_api.Update.REPROXY_ERROR, null);
          break;
        case rtc_to_net.Status.REPROXY_WORKING:
          this.sendUpdate_(uproxy_core_api.Update.REPROXY_WORKING, null);
          break;
        default:
          log.warn('Received unrecognized status update from RtcToNet: %1', status);
      }
    }

    private stateRefresh_ = () => {
      this.sendUpdate_(uproxy_core_api.Update.STATE, this.getCurrentState());
    }

    public getCurrentState = () :uproxy_core_api.ConnectionState => {
      return {
        bytesSent: this.bytesSent_,
        bytesReceived: this.bytesReceived_,
        localGettingFromRemote: this.localGettingFromRemote,
        localSharingWithRemote: this.localSharingWithRemote,
        activeEndpoint: this.activeEndpoint,
      };
    }

    public getProxyingId = () : string => {
      return this.proxyingId_;
    }
  }
// }
