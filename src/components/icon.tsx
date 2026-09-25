import type { CSSProperties } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ban, Bell, BellOff, Bold, BookOpen, Calendar, Camera, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Clock, Cloud, CloudOff, Code, Coffee, Copy, Crown, Ellipsis, ExternalLink, Eye, Flag, GraduationCap, GripHorizontal, GripVertical, House, ImageUp, Inbox, Info, Italic, Layers, ListChecks, LoaderCircle, Lock, LockOpen, LogOut, MapPin, MessageCircle, MessageSquarePlus, Moon, Palette, Pencil, Plus, RefreshCw, Search, SendHorizontal, Settings, Sparkles, Star, Strikethrough, Sun, Trash2, TriangleAlert, Type, UserMinus, UserPlus, Users, Utensils, X,
  type LucideIcon,
} from 'lucide-react';

/** Named icons keep call sites short; the set is lucide, the shadcn/ui icon library. */
const icons = {
  home: House,
  calendar: Calendar,
  camera: Camera,
  check: Check,
  checkCircle: CircleCheck,
  tasks: ListChecks,
  book: BookOpen,
  school: GraduationCap,
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  clock: Clock,
  pin: MapPin,
  plus: Plus,
  x: X,
  trash: Trash2,
  edit: Pencil,
  star: Star,
  logout: LogOut,
  cloud: Cloud,
  cloudOff: CloudOff,
  refresh: RefreshCw,
  alert: TriangleAlert,
  info: Info,
  lock: Lock,
  unlock: LockOpen,
  users: Users,
  search: Search,
  settings: Settings,
  sun: Sun,
  moon: Moon,
  copy: Copy,
  eye: Eye,
  externalLink: ExternalLink,
  inbox: Inbox,
  more: Ellipsis,
  coffee: Coffee,
  utensils: Utensils,
  sparkle: Sparkles,
  layers: Layers,
  grip: GripVertical,
  drag: GripHorizontal,
  bell: Bell,
  bellOff: BellOff,
  message: MessageCircle,
  send: SendHorizontal,
  palette: Palette,
  spinner: LoaderCircle,
  // Chat (docs/CHAT.md §12-§14): formatting, receipts, groups, reports and appeals.
  bold: Bold,
  italic: Italic,
  strikethrough: Strikethrough,
  code: Code,
  textFormat: Type,
  checkCheck: CheckCheck,
  userPlus: UserPlus,
  userMinus: UserMinus,
  newGroup: MessageSquarePlus,
  crown: Crown,
  flag: Flag,
  ban: Ban,
  imageUp: ImageUp,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, strokeWidth = 2, className, style }: { name: IconName; size?: number; strokeWidth?: number; className?: string; style?: CSSProperties }) {
  const Component = icons[name];
  return <Component size={size} strokeWidth={strokeWidth} aria-hidden="true" className={className} style={{ flexShrink: 0, ...style }} />;
}

/** Spinning loader for busy states. */
export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return <LoaderCircle size={size} aria-hidden="true" className={`animate-spin shrink-0 ${className ?? ''}`} />;
}
