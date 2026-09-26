import { relayToCell } from '../../../../../../server/bff';
import { bffDeps } from '../../../../../../server/deps';

export const dynamic = 'force-dynamic';

/** Signed-in TOTP enrolment (enroll, confirm) from Personal settings → Security. */
export const POST = (request: Request) => relayToCell(request, bffDeps(), 'POST');
