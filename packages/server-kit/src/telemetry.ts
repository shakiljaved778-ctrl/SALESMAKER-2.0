import { trace, type Attributes } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

/**
 * Start OpenTelemetry tracing (§3.6, §11.4). Import and call this first in each service's
 * entry point, before any instrumented module loads. It does nothing unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, so tests and scripts stay quiet.
 */
export function startTelemetry(serviceName: string): void {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint || sdk) return;
  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } }),
    ],
  });
  sdk.start();
}

export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

/** Add attributes (tenant.id, user.id, route, db.statement.count) to the active span. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
