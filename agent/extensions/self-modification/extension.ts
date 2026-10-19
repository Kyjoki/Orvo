import selfModification from 'eve/self-modification/local';

// withEve starts eve dev with bundled extensions. Explicitly shadow its mount:
// production task execution must never expose local source modification tools.
export default selfModification({ local: { enabled: false } });
