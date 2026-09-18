import { statusMark, statusTone } from '@/components/messages/messageStatus';

/**
 * Which mark a message's status draws.
 *
 * One case here is the point and the rest are its context: a send that failed
 * must not draw the clock. The clock says "still on its way", and it is the one
 * thing a failed send is not — the Rust SDK's queue has stopped retrying, and on
 * the web there was never a queue to retry with. A user looking at a clock waits;
 * a user looking at an error sends it again.
 */

describe('statusMark', () => {
  it('draws a failed send as an error and never as the clock', () => {
    expect(statusMark('failed')).toBe('error');
    expect(statusMark('failed')).not.toBe('clock');
  });

  it('draws a message still on its way as the clock', () => {
    expect(statusMark('pending')).toBe('clock');
  });

  it('draws a sent message as one tick', () => {
    expect(statusMark('sent')).toBe('tick');
  });

  it('draws a delivered message as two ticks, apart from a sent one', () => {
    // The delivered receipt says a recipient's device has the message; one
    // tick would say only that the server does, which was already known.
    expect(statusMark('delivered')).toBe('double-tick');
    expect(statusMark('delivered')).not.toBe(statusMark('sent'));
  });

  it('draws a read message as two ticks', () => {
    expect(statusMark('read')).toBe('double-tick');
  });

  it('tells read from delivered by tone, since both draw two ticks', () => {
    expect(statusTone('delivered')).toBe('quiet');
    expect(statusTone('read')).toBe('accent');
    expect(statusTone('read')).not.toBe(statusTone('delivered'));
  });

  it('keeps every mark before read quiet and the failure its own tone', () => {
    expect(statusTone('pending')).toBe('quiet');
    expect(statusTone('sent')).toBe('quiet');
    expect(statusTone('failed')).toBe('error');
  });

  it('gives failed and pending different marks', () => {
    // Stated on its own because the two are one careless `default:` apart, and
    // that is exactly how this was drawn before.
    expect(statusMark('failed')).not.toBe(statusMark('pending'));
  });

  it('gives every status a mark', () => {
    const statuses = ['pending', 'sent', 'delivered', 'read', 'failed'] as const;

    for (const status of statuses) {
      expect(statusMark(status)).toBeDefined();
      expect(statusTone(status)).toBeDefined();
    }
  });
});
