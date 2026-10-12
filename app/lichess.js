// "Analyze on Lichess": import the PGN as a game and open it. Lichess only
// answers with JSON (instead of redirecting) when asked for it, and only
// JSON responses carry the headers a page on another site needs.

export async function importGame(pgn) {
  const res = await fetch('https://lichess.org/api/import', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({ pgn }),
  });
  if (!res.ok) throw new Error(`Lichess said ${res.status}`);
  const data = await res.json();
  if (!data.url) throw new Error('Lichess did not return a link');
  return data.url;
}

// Works without the import API: the analysis board accepts moves in the
// address (about 5000 characters).
export function analysisUrl(sans) {
  return `https://lichess.org/analysis/pgn/${encodeURIComponent(sans.join(' ')).replace(/%20/g, '_')}`;
}

// Opens a window right away (so the browser doesn't block it as a popup)
// and points it at the imported game once Lichess answers.
export async function analyzeOnLichess(pgn, sans) {
  const win = window.open('', '_blank');
  try {
    const url = await importGame(pgn);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch {
    const url = analysisUrl(sans);
    if (win) win.location.href = url;
    else window.location.href = url;
  }
}
