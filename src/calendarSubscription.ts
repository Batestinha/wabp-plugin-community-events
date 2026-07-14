export function eventsCalendarSubscriptionUrl(input: {
  operatorConsolePublicOrigin?: string | undefined;
  runtimeBindingId?: string | undefined;
  scopeId: string;
  calendarId: string;
  token?: string | undefined;
}): string {
  const origin = input.operatorConsolePublicOrigin?.trim() ?? '';
  const runtimeBindingId = input.runtimeBindingId?.trim() ?? '';
  const token = input.token?.trim() ?? '';
  if (!origin || !runtimeBindingId || !token) {
    return '';
  }
  try {
    const url = new URL(
      `/api/v1/plugins/official.community-events/calendar/${encodeURIComponent(runtimeBindingId)}/${encodeURIComponent(input.scopeId)}/${encodeURIComponent(input.calendarId)}.ics`,
      origin
    );
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return '';
  }
}

