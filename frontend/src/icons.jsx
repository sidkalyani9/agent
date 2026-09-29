function Svg({ children, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function IconRecord() {
  return (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </Svg>
  );
}

export function IconStock() {
  return (
    <Svg>
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </Svg>
  );
}

export function IconChart() {
  return (
    <Svg>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l4-5 3 3 5-7" />
    </Svg>
  );
}

export function IconActivity() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </Svg>
  );
}

export function IconAssistant() {
  return (
    <Svg>
      <path d="M12 3l1.2 3.6L17 8l-3.8 1.4L12 13l-1.2-3.6L7 8l3.8-1.4Z" />
      <path d="M6 14l.6 1.8L8.5 16.5 6.6 17.1 6 19l-.6-1.9L3.5 16.5l1.9-.7Z" />
      <path d="M18 13l.7 2 2 .8-2 .7-.7 2-.7-2-2-.7 2-.8Z" />
    </Svg>
  );
}

export function IconSun() {
  return (
    <Svg size={18}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </Svg>
  );
}

export function IconMoon() {
  return (
    <Svg size={18}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5Z" />
    </Svg>
  );
}

export function IconSystem() {
  return (
    <Svg size={18}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </Svg>
  );
}

export function IconLogout() {
  return (
    <Svg size={18}>
      <path d="M9 6V4H5v16h4v-2" />
      <path d="M10 12h10" />
      <path d="m16 8 4 4-4 4" />
    </Svg>
  );
}

export function IconSend() {
  return (
    <Svg size={18}>
      <path d="M4 12 20 4l-6 16-2.5-6.5Z" />
    </Svg>
  );
}

export function IconClose() {
  return (
    <Svg size={18}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconPlus() {
  return (
    <Svg size={18}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconChats() {
  return (
    <Svg size={18}>
      <path d="M8 7h8M8 11h8M8 15h5" />
      <path d="M5 4h14v12H8l-3 3Z" />
    </Svg>
  );
}

export function IconBack() {
  return (
    <Svg size={18}>
      <path d="M15 6 9 12l6 6" />
      <path d="M9 12h10" />
    </Svg>
  );
}

export function IconAccess() {
  return (
    <Svg>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M17 11v6M14 14h6" />
    </Svg>
  );
}

export function IconMenu() {
  return (
    <Svg>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconFile() {
  return (
    <Svg>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </Svg>
  );
}

export function IconOffice() {
  return (
    <Svg>
      <path d="M4 20V6l8-3 8 3v14" />
      <path d="M9 20v-6h6v6" />
      <path d="M4 10h16" />
    </Svg>
  );
}

export function IconSettings() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5" />
    </Svg>
  );
}

export function IconChevron() {
  return (
    <Svg size={16}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function IconMicrosoft() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
