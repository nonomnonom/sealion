import type { ActionResult, ActionType, ChannelMessage, ChannelResponse } from "./typing.ts";

type Resolver<T> = (value: T) => void;

/**
 * Actor-style mailbox connecting agents to the exchange. Agents push action
 * requests onto `receiveQueue` (read by `Exchange.runLoop`); responses come
 * back per-agent via `sendQueue`.
 *
 * Correctness: the queue preserves FIFO per agent under JS's single-threaded
 * event loop. Multiple in-flight requests from the same agent get their
 * responses in submission order without explicit message-id correlation.
 */
export class Channel {
  private receiveQueue: ChannelMessage[] = [];
  private receiveWaiters: Resolver<ChannelMessage>[] = [];
  private sendBuckets: Map<number, ChannelResponse[]> = new Map();
  private sendWaiters: Map<number, Resolver<ChannelResponse>[]> = new Map();

  /** Push a request from an agent (or `null` for control messages like EXIT). */
  writeToReceiveQueue(msg: ChannelMessage): void {
    const waiter = this.receiveWaiters.shift();
    if (waiter) {
      waiter(msg);
      return;
    }
    this.receiveQueue.push(msg);
  }

  /** Pull the next pending request. Used by `Exchange.runLoop`. */
  readFromReceiveQueue(): Promise<ChannelMessage> {
    const msg = this.receiveQueue.shift();
    if (msg) return Promise.resolve(msg);
    const { promise, resolve } = Promise.withResolvers<ChannelMessage>();
    this.receiveWaiters.push(resolve);
    return promise;
  }

  /** Push a response to a specific agent's bucket. */
  writeToSendQueue(agentId: number, result: ActionResult, actionType: ActionType): void {
    const response: ChannelResponse = { actionType, result };
    const waiters = this.sendWaiters.get(agentId);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter(response);
      return;
    }
    let bucket = this.sendBuckets.get(agentId);
    if (!bucket) {
      bucket = [];
      this.sendBuckets.set(agentId, bucket);
    }
    bucket.push(response);
  }

  /** Wait for the next response addressed to `agentId`. FIFO. */
  readFromSendQueue(agentId: number): Promise<ChannelResponse> {
    const bucket = this.sendBuckets.get(agentId);
    if (bucket && bucket.length > 0) {
      return Promise.resolve(bucket.shift()!);
    }
    const { promise, resolve } = Promise.withResolvers<ChannelResponse>();
    let waiters = this.sendWaiters.get(agentId);
    if (!waiters) {
      waiters = [];
      this.sendWaiters.set(agentId, waiters);
    }
    waiters.push(resolve);
    return promise;
  }
}
