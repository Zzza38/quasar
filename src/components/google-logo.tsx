/** Standard four-color Google sign-in mark, kept inline for offline rendering. */
export function GoogleLogo() {
  return <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white" aria-hidden="true">
    <svg className="size-[18px]" viewBox="0 0 24 24" focusable="false">
      <path fill="#4285F4" d="M22.56 12.25c0-.73-.06-1.42-.19-2.09H12v3.96h5.92c-.26 1.28-1.04 2.36-2.21 3.09v2.57h3.58c2.08-1.92 3.27-4.74 3.27-7.53Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.58-2.57c-.98.66-2.23 1.06-3.7 1.06-2.87 0-5.31-1.94-6.18-4.54H2.15v2.65A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.82 14.29A6.6 6.6 0 0 1 5.47 12c0-.79.13-1.56.35-2.29V7.06H2.15A11 11 0 0 0 1 12c0 1.78.43 3.47 1.15 4.94l3.67-2.65Z" />
      <path fill="#EA4335" d="M12 5.17c1.62 0 3.06.56 4.21 1.64l3.16-3.16C17.45 1.86 14.97 1 12 1a11 11 0 0 0-9.85 6.06l3.67 2.65C6.69 7.11 9.13 5.17 12 5.17Z" />
    </svg>
  </span>;
}
