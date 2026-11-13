// A stand-in for official.geocoder's resolve / choose / remember / timezoneForPoint, for event flow tests.
// It mirrors the geocoder's contract, not its full rules (those are tested in wabp-plugin-geocoder):
// one result or a remembered text is certain, more results are ambiguous; replies follow the same shapes.

const norm = value => String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function fakeGeocoder(results, options = {}) {
  const calls = [];
  const remembered = [];
  const memory = new Map((options.known ?? []).map(place => [norm(place.query), place.place]));
  const output = (query, places, status, fromMemory) => ({
    status, query, searchQuery: query, remembered: fromMemory, provider: 'fixture', fetchedAt: '2026-10-16T09:00:00.000Z',
    candidates: places.map(place => ({ place, shortLabel: place.label, remembered: false, nameMatch: false })),
    presentation: { optionLines: places.map((place, index) => `${index + 1}. ${place.label}`), optionLabels: places.map(place => place.label) }
  });
  const handlers = {
    timezoneForPoint: () => options.timezone ?? { timezone: 'Europe/Lisbon', candidates: ['Europe/Lisbon'] },
    resolve: ({ query, memoryOnly }) => {
      const known = memory.get(norm(query));
      if (memoryOnly) return output(query, known ? [known] : [], known ? 'resolved' : 'not_found', Boolean(known));
      const places = [...(known ? [known] : []), ...results(query)];
      return output(query, places, places.length === 0 ? 'not_found' : known || places.length === 1 ? 'resolved' : 'ambiguous', Boolean(known));
    },
    choose: ({ reply, candidates, status, searchQuery }) => {
      const text = reply.trim();
      if (/^\d+$/.test(text)) {
        const index = Number(text) - 1;
        return candidates[index] ? { status: 'selected', index, place: candidates[index] } : { status: 'invalid' };
      }
      if (['ok', 'sim', 'yes'].includes(norm(text)) && candidates.length > 0 && (candidates.length === 1 || status === 'resolved')) {
        return { status: 'selected', index: 0, place: candidates[0] };
      }
      const typed = candidates.flatMap((place, index) => [place.label, place.label.split(',')[0]].map(norm).includes(norm(text)) ? [index] : []);
      if (typed.length === 1) return { status: 'selected', index: typed[0], place: candidates[typed[0]] };
      if (!text || text.startsWith('/')) return { status: 'invalid' };
      if (candidates.length > 0 && norm(text) === norm(searchQuery)) {
        return { status: 'ask_number', text: [`Reply with the number of the right one (1 to ${candidates.length})`,
          ...candidates.map((place, index) => `${index + 1}. ${place.label}`)].join('\n') };
      }
      return { status: 'search', query: text };
    },
    remember: ({ places }) => {
      remembered.push(...places);
      for (const item of places) memory.set(norm(item.query), item.place);
      return { places: memory.size, changed: true };
    }
  };
  return {
    calls, remembered,
    async call(input) {
      calls.push(input);
      const handler = handlers[input.method];
      if (!handler) throw new Error(`Unexpected geocoder method ${input.method}`);
      return structuredClone(handler(input.input ?? {}));
    }
  };
}

module.exports = { fakeGeocoder };
