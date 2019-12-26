// @flow strict

// Copyright 2018 dialog LLC <info@dlg.im>

import Nanoevents from 'nanoevents';

import type {
  RpcCall,
  UnaryRequest,
  StreamRequest,
  ClientStreamCall as IClientStreamCall,
} from './types';
import { type Transport } from './transport';
import { createSequence, type Sequence } from './utils/sequence';
import { RpcError } from './RpcError';
import { IRpcClient } from './IRpcClient';

import UnaryCall from './UnaryCall';
import ServerStreamCall from './ServerStreamCall';
import BidiStreamCall from './BidiStreamCall';
import ClientStreamCall from './ClientStreamCall';

class RpcClient implements IRpcClient<RpcCall, IClientStreamCall> {
  seq: Sequence;
  calls: Map<string, RpcCall>;
  transport: Transport;

  constructor(transport: Transport) {
    this.calls = new Map();
    this.seq = createSequence();
    this.setTransport(transport);
  }

  setTransport(transport: Transport) {
    this.transport = transport;
  }

  cancelRequest(id: string) {
    const call = this.calls.get(id);

    if (call) call.cancel();
  }

  makeUnaryRequest(request: UnaryRequest) {
    const id = this.seq.next();

    const call = new UnaryCall(id, this.transport);
    this.calls.set(call.id, call);

    call.start(request).onEnd(() => {
      this.calls.delete(call.id);
    });

    return call;
  }

  makeServerStreamRequest(request: UnaryRequest) {
    const id = this.seq.next();

    const call = new ServerStreamCall(id, this.transport);
    this.calls.set(call.id, call);

    call.start(request).onEnd(() => {
      this.calls.delete(call.id);
    });

    return call;
  }

  makeClientStreamRequest(request: StreamRequest) {
    const id = this.seq.next();

    const call = new ClientStreamCall(id, this.transport);
    this.calls.set(call.id, call);

    call.start(request).onEnd(() => {
      this.calls.delete(call.id);
    });

    return call;
  }

  makeBidiStreamRequest(request: StreamRequest) {
    const id = this.seq.next();

    const call = new BidiStreamCall(id, this.transport);
    this.calls.set(call.id, call);

    call.start(request).onEnd(() => {
      this.calls.delete(call.id);
    });

    return call;
  }
}

export default RpcClient;
