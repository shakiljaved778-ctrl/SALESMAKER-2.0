// Loaded first by main.ts so OpenTelemetry can patch modules before they are imported.
import { startTelemetry } from '@sm/server-kit/telemetry';

startTelemetry('sm-api');
