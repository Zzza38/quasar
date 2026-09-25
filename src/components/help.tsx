'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage, isUnauthorized } from '@/client/api';
import { CHAT } from '@/domain/chat';
import { Icon } from './icon';
import { Brand } from './shell';
import { AppearanceToggle } from './theme-picker';
import { Button, Callout, Hint, Textarea } from './primitives';
import { Card, CardContent } from './ui/card';

export const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  { q: 'My school is not in the list. What do I do?', a: 'Tap “Add a school” on the school step. You will enter the periods, the bell times for a normal day, and how the rotation works, one question at a time. Have the school’s published bell schedule in front of you; it takes about ten minutes. Everyone from your school who joins after you gets it instantly.' },
  { q: 'Which rotation day is it? I do not know what to pick.', a: 'Quasar only needs one date you are sure about, such as “Tuesday the 22nd is Day 3”. It counts forward and backward from there, skipping weekends and days off. If you are not sure, ask a friend or check the school calendar. You can correct it later from the School page, and every schoolmate’s app updates.' },
  { q: 'A bell time is wrong. How do I fix it?', a: 'On Today, tap “Wrong time?” next to the day’s timeline, or open the School page and choose “Edit shared schedule”. Your fix reaches everyone at your school. Once your school has 10 members, editing locks: choose “Propose a change” on the same page and verified schoolmates vote on it. If support locked the schedule, or to reach support directly, use “Request a correction” on the School page.' },
  { q: 'What is the difference between the school schedule and a private one?', a: 'The school schedule is shared: when a schoolmate fixes a bell time or adds a day off, you get it automatically. A private schedule is a copy only you can see and edit. Most people should use the school schedule and add personal adjustments from the Classes page.' },
  { q: 'How do I add my classes?', a: 'Open Classes. Type a class in, pick from what schoolmates already added, or scan a photo of your printed timetable. Then drag each class onto the period it meets in, or tap a period in the list. Once a class has a period, Today shows it with a countdown.' },
  { q: 'Today shows “No class assigned” for a period.', a: 'That period has no class on it yet. Open Classes and drag the right class onto that period. Periods you do not have, like a free block, can stay empty.' },
  { q: 'There was a snow day or a two-hour delay. What do I change?', a: 'If it affects the whole school, add it to the shared schedule: School page, “Edit shared schedule”, then Exceptions. Choose “No school” for a closure, or “Special schedule” for a delay, and say whether the rotation still advances. If it only affects you, use Adjustments on the Classes page.' },
  { q: 'How do I get my Schoology homework into Quasar?', a: 'Open Schoology in a web browser (not the app), click Calendar in the top menu, scroll to the bottom of the calendar and click Export in the middle. In the Export iCal Feed box choose Share Calendar (not Download Calendar) and copy the link that ends in .ics. In Quasar, open Schedule, tap Add calendar under Connected calendars, and paste the link. Every assignment with a due date becomes a task, and new ones keep arriving. Google Classroom and Canvas work the same way; the Add calendar dialog shows the steps for each.' },
  { q: 'Does it work without internet?', a: 'Yes, once you have opened Quasar online on this device. Tasks and adjustments you make offline are saved and upload themselves when you reconnect. Choosing a school and editing the shared schedule need a connection.' },
  { q: 'How do I put it on my home screen?', a: 'iPhone: open Quasar in Safari, tap the Share button, then “Add to Home Screen”. Android: open the Chrome menu and tap “Add to Home screen” or “Install app”. Laptop: click the install icon at the right end of the address bar.' },
  { q: 'Reminders are not arriving.', a: 'Open Account from your avatar and check that “Task reminders” is on for this browser. On iPhone, reminders only work from the home-screen version of Quasar. Reminders are sent only for tasks that have a due date and a reminder set.' },
  { q: 'Who can see my name?', a: 'Your display name is visible to people at your school, and to everyone on Quasar when you post in the global chat. Your full name is shown only when you and the person viewing are both verified. Nothing is sold and there are no ads or trackers.' },
  { q: 'Who can message me?', a: 'Only friends can send you private messages. Removing a friend or blocking closes the chat for both of you. The global chat is different: everyone on Quasar can post there, and you can mute it.' },
  { q: 'What is the global chat?', a: 'One room under Group chats that everyone on Quasar can read and post in. Swearing is fine, slurs are censored to asterisks in every chat, and the owner can edit or remove any message in the room, with the reason shown in its place.' },
  { q: 'Can support read my messages?', a: `Your private chats, only through a report. A report shares up to ${CHAT.evidence} messages from that one chat with support, and nobody at Quasar browses private chats. To keep accounts safe, support can see who you chat with and how many messages you’ve exchanged, never what they say. The global chat is public: the owner can read, edit and remove any post there.` },
  { q: 'How do I sign out or delete my data?', a: `Open Account from your avatar and choose “Sign out”. Signing out removes your data from this device. You can delete your own tasks and classes at any time. Deleting a whole account is not available yet. Chat messages are deleted automatically ${CHAT.retentionDays} days after they are sent, except messages copied into a report, which support keeps until ${CHAT.evidenceDays} days after the report is closed.` },
];

export function Help() {
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  // The message is bound to the account signed in when the page opened, so switching accounts in another tab
  // cannot file it under a different account (the server rejects a mismatched accountId).
  const [account, setAccount] = useState<{ id: string; email: string } | null>(null);
  useEffect(() => {
    let active = true;
    api.session.query().then((session) => { if (active && session) setAccount({ id: session.user.id, email: session.user.email }); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const send = async () => {
    setPending(true); setError('');
    try {
      const accountId = account?.id ?? (await api.session.query())?.user.id;
      if (!accountId) { setError('Sign in to Quasar first, then come back here to send a message.'); return; }
      await api.school.feedback.mutate({ accountId, message: message.trim() }); setSent(true); setMessage('');
    }
    catch (err) { setError(isUnauthorized(err) && !account ? 'Sign in to Quasar first, then come back here to send a message.' : errorMessage(err)); }
    finally { setPending(false); }
  };
  return <main className="welcome-bg min-h-dvh px-3 py-6 sm:px-4 sm:py-10">
    <div className="mx-auto grid w-full max-w-[760px] gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Brand href="/" />
        <div className="flex items-center gap-2"><AppearanceToggle /><a href="/" className="text-sm font-semibold text-primary hover:underline" onClick={(event) => {
          // Help opens in the same tab from Account; going back keeps the view the student came from.
          if (window.history.length > 1 && document.referrer.startsWith(window.location.origin)) { event.preventDefault(); window.history.back(); }
        }}>Back to Quasar</a></div>
      </header>
      <Card className="rounded-3xl shadow-float"><CardContent className="grid gap-5 sm:px-8">
        <div className="grid gap-1.5"><h1 className="text-[28px]">Help</h1><p className="text-sm text-muted-foreground">Short answers to the questions people ask most. If yours is not here, send a message at the bottom.</p></div>
        <div className="grid gap-2">
          {FAQ.map((entry) => <details key={entry.q} className="group rounded-2xl bg-muted/60 ring-1 ring-inset ring-foreground/[0.04] open:bg-card open:ring-primary/30">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[15px] font-bold marker:hidden [&::-webkit-details-marker]:hidden"><span>{entry.q}</span><Icon name="chevronDown" size={16} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
            <p className="px-4 pb-4 text-sm leading-relaxed text-muted-foreground">{entry.a}</p>
          </details>)}
        </div>
      </CardContent></Card>
      <Card className="rounded-3xl shadow-float"><CardContent className="grid gap-4 sm:px-8">
        <div className="grid gap-1.5"><h2 className="text-xl">Still stuck?</h2><p className="text-sm text-muted-foreground">Tell us what you were trying to do and what happened. Include your school’s name if it is about the schedule.</p></div>
        {sent && <Callout tone="success" icon="check" role="status">Sent. You will hear back by email.</Callout>}
        {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
        <Textarea aria-label="Your message" rows={5} maxLength={5000} placeholder="I added my school but Day 3 shows on the wrong date…" value={message} disabled={pending} onChange={(event) => setMessage(event.target.value)} />
        <div className="flex flex-wrap items-center gap-3"><Button variant="primary" busy={pending} disabled={message.trim().length < 10} onClick={() => void send()}>Send message</Button><Hint>Needs at least ten characters. Goes to the person who runs Quasar{account ? `, sent as ${account.email}` : ''}.</Hint></div>
      </CardContent></Card>
    </div>
  </main>;
}
