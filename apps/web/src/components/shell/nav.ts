import {
  BarChart3,
  Building2,
  CalendarCheck,
  CircleHelp,
  Contact,
  FileText,
  Handshake,
  Home,
  Inbox,
  Kanban,
  LayoutDashboard,
  Phone,
  Settings,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

export type NavKey =
  | 'home'
  | 'inbox'
  | 'leads'
  | 'accounts'
  | 'contacts'
  | 'opportunities'
  | 'pipeline'
  | 'activities'
  | 'dialer'
  | 'quotes'
  | 'forecast'
  | 'reports'
  | 'dashboards'
  | 'setup'
  | 'help';

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Second key of the `G then …` shortcut (§9.11). */
  go?: string;
}

/** Sidebar order (§9.7). Only Home is live in P00; the rest render their "on its way" page. */
export const MAIN_NAV: NavItem[] = [
  { key: 'home', href: '/home', icon: Home, go: 'h' },
  { key: 'inbox', href: '/inbox', icon: Inbox },
  { key: 'leads', href: '/leads', icon: UserPlus, go: 'l' },
  { key: 'accounts', href: '/accounts', icon: Building2, go: 'a' },
  { key: 'contacts', href: '/contacts', icon: Contact, go: 'c' },
  { key: 'opportunities', href: '/opportunities', icon: Handshake, go: 'o' },
  { key: 'pipeline', href: '/pipeline', icon: Kanban, go: 'p' },
  { key: 'activities', href: '/activities', icon: CalendarCheck },
  { key: 'dialer', href: '/dialer', icon: Phone },
  { key: 'quotes', href: '/quotes', icon: FileText },
  { key: 'forecast', href: '/forecast', icon: TrendingUp, go: 'f' },
  { key: 'reports', href: '/reports', icon: BarChart3, go: 'r' },
  { key: 'dashboards', href: '/dashboards', icon: LayoutDashboard, go: 'd' },
];

export const FOOTER_NAV: NavItem[] = [
  { key: 'setup', href: '/setup', icon: Settings },
  { key: 'help', href: '/help', icon: CircleHelp },
];

export const ALL_NAV = [...MAIN_NAV, ...FOOTER_NAV];

/** Sections that exist as routes but whose modules arrive in later phases. */
export const PLACEHOLDER_SECTIONS = new Set(
  ALL_NAV.filter((n) => n.key !== 'home').map((n) => n.key),
);

export function navFor(pathname: string): NavItem | undefined {
  return ALL_NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
}
