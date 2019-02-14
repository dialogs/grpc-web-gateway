// @flow strict
// Copyright 2018 dialog LLC <info@dlg.im>

import { Observable } from 'rxjs';
import {
  RpcClient,
  RpcError,
  type RpcCall,
  type ClientStreamCall,
  type UnaryRequest,
  type StreamRequest,
  type PushRequest,
  type IRpcClient,
} from '@dlghq/grpc-web-gateway-client';

export type RxUnaryCall = {
  execute(): Observable<Uint8Array>,
  cancel(): void,
};

export type RxClientStreamCall = RxUnaryCall & {
  send(PushRequest): void,
  end(): void,
};

const observableFromUnaryCall = (makeCall: () => RpcCall): RxUnaryCall => {
  let call = null;

  return {
    execute: () => {
      return Observable.create(observer => {
        call = makeCall();

        call.onMessage(message => observer.next(message));

        call.onError(error => observer.error(error));

        call.onEnd(() => observer.complete());
      });
    },
    cancel: () => (call ? call.cancel() : undefined),
  };
};

const observableFromClientStreamCall = (
  makeCall: () => ClientStreamCall,
): RxClientStreamCall => {
  const call = makeCall();

  return {
    execute: () => {
      return Observable.create(observer => {
        call.onMessage(message => observer.next(message));

        call.onError(error => observer.error(error));

        call.onEnd(() => observer.complete());
      });
    },
    send: request => call.send(request),
    end: () => call.end(),
    cancel: () => call.cancel(),
  };
};

export class RxRpcClient
  implements IRpcClient<RxUnaryCall, RxClientStreamCall> {
  rpcClient: RpcClient;

  constructor(rpcClient: RpcClient) {
    this.rpcClient = rpcClient;
  }

  makeUnaryRequest(request: UnaryRequest): RxUnaryCall {
    return observableFromUnaryCall(() =>
      this.rpcClient.makeUnaryRequest(request),
    );
  }

  makeServerStreamRequest(request: UnaryRequest): RxUnaryCall {
    return observableFromUnaryCall(() =>
      this.rpcClient.makeServerStreamRequest(request),
    );
  }

  makeClientStreamRequest(request: StreamRequest): RxClientStreamCall {
    return observableFromClientStreamCall(() =>
      this.rpcClient.makeClientStreamRequest(request),
    );
  }

  makeBidiStreamRequest(request: StreamRequest): RxClientStreamCall {
    return observableFromClientStreamCall(() =>
      this.rpcClient.makeBidiStreamRequest(request),
    );
  }

  onError(handler: RpcError => void) {
    return this.rpcClient.onError(handler);
  }
}