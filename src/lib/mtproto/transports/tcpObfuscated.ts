/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import Modes from "../../../config/modes";
import { logger, LogTypes } from "../../logger";
import MTPNetworker from "../networker";
import Obfuscation from "./obfuscation";
import MTTransport, { MTConnection, MTConnectionConstructable } from "./transport";
import intermediatePacketCodec from './intermediate';
import { ConnectionStatus } from "../connectionStatus";

export default class TcpObfuscated implements MTTransport {
  private codec = intermediatePacketCodec;
  private obfuscation = new Obfuscation();
  public networker: MTPNetworker;

  private pending: Array<Partial<{
    resolve: any, 
    reject: any, 
    body: Uint8Array, 
    encoded?: Uint8Array,
    bodySent: boolean
  }>> = [];

  private debug = Modes.debug && false/* true */;
  private log: ReturnType<typeof logger>;
  public connected = false;
  private lastCloseTime: number;
  private connection: MTConnection;

  private autoReconnect = true;
  private reconnectTimeout: number;

  //private debugPayloads: MTPNetworker['debugRequests'] = [];

  constructor(private Connection: MTConnectionConstructable, 
    private dcId: number, 
    private url: string, 
    private logSuffix: string, 
    private retryTimeout: number
  ) {
    let logTypes = LogTypes.Error | LogTypes.Log;
    if(this.debug) logTypes |= LogTypes.Debug;
    this.log = logger(`TCP-${dcId}` + logSuffix, logTypes);
    this.log('constructor');
    
    this.connect();
  }

  private onOpen = () => {
    this.connected = true;

    const initPayload = this.obfuscation.init(this.codec);

    this.connection.send(initPayload);

    if(this.networker) {
      this.pending.length = 0; // ! clear queue and reformat messages to container, because if sending simultaneously 10+ messages, connection will die
      this.networker.setConnectionStatus(ConnectionStatus.Connected);
      this.networker.cleanupSent();
      this.networker.resend();
    } else {
      for(const pending of this.pending) {
        if(pending.encoded && pending.body) {
          pending.encoded = this.encodeBody(pending.body);
        }
      }
    }

    setTimeout(() => {
      this.releasePending();
    }, 0);
  };

  private onMessage = (buffer: ArrayBuffer) => {
    let data = this.obfuscation.decode(new Uint8Array(buffer));
    data = this.codec.readPacket(data);

    if(this.networker) { // authenticated!
      //this.pending = this.pending.filter(p => p.body); // clear pending

      this.debug && this.log.debug('redirecting to networker', data.length);
      this.networker.parseResponse(data).then(response => {
        this.debug && this.log.debug('redirecting to networker response:', response);

        try {
          this.networker.processMessage(response.response, response.messageId, response.sessionId);
        } catch(err) {
          this.log.error('handleMessage networker processMessage error', err);
        }

        //this.releasePending();
      }).catch(err => {
        this.log.error('handleMessage networker parseResponse error', err);
      });

      //this.dd();
      return;
    }

    //console.log('got hex:', data.hex);
    const pending = this.pending.shift();
    if(!pending) {
      this.debug && this.log.debug('no pending for res:', data.hex);
      return;
    }

    pending.resolve(data);
  };

  private onClose = () => {
    this.clear();
    
    let needTimeout: number, retryAt: number;
    if(this.autoReconnect) {
      const time = Date.now();
      const diff = time - this.lastCloseTime;
      needTimeout = !isNaN(diff) && diff < this.retryTimeout ? this.retryTimeout - diff : 0;
      retryAt = time + needTimeout;
    }
    
    if(this.networker) {
      this.networker.setConnectionStatus(ConnectionStatus.Closed, retryAt);
      this.pending.length = 0;
    }

    if(this.autoReconnect) {
      this.log('will try to reconnect after timeout:', needTimeout / 1000);
      this.reconnectTimeout = self.setTimeout(this.reconnect, needTimeout);
    } else {
      this.log('reconnect isn\'t needed');
    }
  };

  public clear() {
    this.connected = false;

    if(this.connection) {
      this.connection.removeEventListener('open', this.onOpen);
      this.connection.removeEventListener('close', this.onClose);
      this.connection.removeEventListener('message', this.onMessage);
      this.connection = undefined;
    }
  }

  /**
   * invoke only when closed
   */
  public reconnect = () => {
    if(this.reconnectTimeout !== undefined) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if(this.connection) {
      return;
    }

    this.log('trying to reconnect...');
    this.lastCloseTime = Date.now();
    
    if(!this.networker) {
      for(const pending of this.pending) {
        if(pending.bodySent) {
          pending.bodySent = false;
        }
      }
    } else {
      this.networker.setConnectionStatus(ConnectionStatus.Connecting);
    }

    this.connect();
  }

  public forceReconnect() {
    this.close();
    this.reconnect();
  }

  public destroy() {
    this.setAutoReconnect(false);
    this.close();
  }

  public close() {
    const connection = this.connection;
    if(connection) {
      const connected = this.connected;
      this.clear();
      if(connected) { // wait for buffered messages if they are there
        connection.addEventListener('message', this.onMessage);
        connection.addEventListener('close', () => {
          connection.removeEventListener('message', this.onMessage);
        }, true);
        connection.close();
      }
    }
  }

  /**
   * Will connect if enable and disconnected \
   * Will reset reconnection timeout if disable
   */
  public setAutoReconnect(enable: boolean) {
    this.autoReconnect = enable;

    if(!enable) {
      if(this.reconnectTimeout !== undefined) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
    } else if(!this.connection && this.reconnectTimeout === undefined) {
      this.reconnect();
    }
  }

  private connect() {
    if(this.connection) {
      this.close();
    }

    this.connection = new this.Connection(this.dcId, this.url, this.logSuffix);
    this.connection.addEventListener('open', this.onOpen);
    this.connection.addEventListener('close', this.onClose);
    this.connection.addEventListener('message', this.onMessage);
  }

  private encodeBody(body: Uint8Array) {
    const toEncode = this.codec.encodePacket(body);

    //this.log('send before obf:', /* body.hex, nonce.hex, */ toEncode.hex);
    const encoded = this.obfuscation.encode(toEncode);
    //this.log('send after obf:', enc.hex);

    return encoded;
  }

  public send(body: Uint8Array) {
    this.debug && this.log.debug('-> body length to pending:', body.length);

    const encoded: typeof body = this.connected ? this.encodeBody(body) : undefined;

    //return;

    if(this.networker) {
      this.pending.push({body, encoded});
      this.releasePending();
    } else {
      const promise = new Promise<typeof body>((resolve, reject) => {
        this.pending.push({resolve, reject, body, encoded});
      });

      this.releasePending();

      return promise;
    }
  }

  private releasePending(/* tt = false */) {
    if(!this.connected) {
      //this.connect();
      return;
    }

    /* if(!tt) {
      this.releasePendingDebounced();
      return;
    } */

    //this.log('-> messages to send:', this.pending.length);
    let length = this.pending.length;
    //for(let i = length - 1; i >= 0; --i) {
    for(let i = 0; i < length; ++i) {
      /* if(this.ws.bufferedAmount) {
        break;
      } */

      const pending = this.pending[i];
      const {body, bodySent} = pending;
      let encoded = pending.encoded;
      if(body && !bodySent) {

        //this.debugPayloads.push({before: body.slice(), after: enc});

        this.debug && this.log.debug('-> body length to send:', body.length);
        /* if(this.ws.bufferedAmount) {
          this.log.error('bufferedAmount:', this.ws.bufferedAmount);
        } */

        /* if(this.ws.readyState !== this.ws.OPEN) {
          this.log.error('ws is closed?');
          this.connected = false;
          break;
        } */

        if(!encoded) {
          encoded = pending.encoded = this.encodeBody(body);
        }

        //this.lol.push(body);
        //setTimeout(() => {
          this.connection.send(encoded);
        //}, 100);
        //this.dd();
        
        if(!pending.resolve) { // remove if no response needed
          this.pending.splice(i--, 1);
          length--;
        } else {
          pending.bodySent = true;
        }

        //delete pending.body;
      }
    }
  }
}
