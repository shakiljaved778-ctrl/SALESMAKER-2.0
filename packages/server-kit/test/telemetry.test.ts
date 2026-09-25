import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import { annotateActiveSpan, startTelemetry, stopTelemetry } from '../src/telemetry.js';

describe('telemetry', () => {
  afterEach(async () => {
    await stopTelemetry();
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  });

  it('does nothing without an OTLP endpoint', () => {
    startTelemetry('test');
    // With no SDK registered the global tracer is a no-op: spans are not recording.
    trace.getTracer('t').startActiveSpan('noop', (span) => {
      expect(span.isRecording()).toBe(false);
      annotateActiveSpan({ 'tenant.id': 't1' }); // must not throw
      span.end();
    });
  });

  it('starts once, records spans with annotations, and stops cleanly', async () => {
    // Nothing listens here; no span is flushed because the exporter is shut down first.
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:9/';
    startTelemetry('test');
    startTelemetry('test'); // idempotent
    trace.getTracer('t').startActiveSpan('work', (span) => {
      expect(span.isRecording()).toBe(true);
      annotateActiveSpan({ 'tenant.id': 't1', 'db.statement.count': 2 });
      expect((span as unknown as { attributes: Record<string, unknown> }).attributes).toMatchObject(
        { 'tenant.id': 't1', 'db.statement.count': 2 },
      );
    });
    await stopTelemetry();
    await stopTelemetry(); // safe when already stopped
  });

  it('annotates nothing when there is no active span', () => {
    expect(() => {
      annotateActiveSpan({ route: '/x' });
    }).not.toThrow();
  });
});
