// no-network.cjs — preloaded (node --require) into every child process the CLI tests start.
//
// Those tests answer every search/lookup from a pre-seeded cache. If a script ever asked for
// something that ISN'T seeded, it would fall through to a real request to Apple, and tests must
// never hit the network. Replacing fetch makes that case fail loudly instead.
// (CommonJS and --require, not --import, because --require works on every Node 18.)

globalThis.fetch = async (url) => {
  throw new Error(`network disabled in tests (tried to fetch ${String(url).split("?")[0]})`);
};
