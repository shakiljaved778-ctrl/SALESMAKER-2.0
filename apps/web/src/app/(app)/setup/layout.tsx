import type { ReactNode } from 'react';

import { SetupShell } from '../../../components/setup/setup-shell';

/** Setup (§9 T5): every page shares the searchable tree; access needs view_setup. */
export default function SetupLayout({ children }: { children: ReactNode }) {
  return <SetupShell>{children}</SetupShell>;
}
