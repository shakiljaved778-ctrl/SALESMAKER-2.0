import { relayToCell } from '../../../../server/bff';
import { bffDeps } from '../../../../server/deps';

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => relayToCell(request, bffDeps(), 'GET');
export const POST = (request: Request) => relayToCell(request, bffDeps(), 'POST');
export const PATCH = (request: Request) => relayToCell(request, bffDeps(), 'PATCH');
export const PUT = (request: Request) => relayToCell(request, bffDeps(), 'PUT');
export const DELETE = (request: Request) => relayToCell(request, bffDeps(), 'DELETE');
