import { redirect } from 'next/navigation';

import { SETUP_HOME } from '../../../components/setup/setup-nav';

export default function SetupHome() {
  redirect(SETUP_HOME);
}
