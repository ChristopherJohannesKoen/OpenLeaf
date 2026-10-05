/** The composition from the design system's cover: the leaf at full size, what it keeps set inside it. */
export function CoverArt() {
  return (
    <svg className="ol-coverart" viewBox="0 0 480 600" preserveAspectRatio="xMinYMid slice" aria-hidden="true">
      <rect className="ol-coverart__desk" x="200" y="340" width="280" height="140" />
      <rect className="ol-coverart__ink" x="40" y="-20" width="160" height="500" />
      <rect className="ol-coverart__patina" x="60" y="340" width="60" height="120" />
      <rect className="ol-coverart__bronze" x="200" y="180" width="120" height="160" />
      <rect className="ol-coverart__cinnabar" x="420" y="300" width="20" height="20" />
      <path className="ol-coverart__line" d="M0 180.5H480 M0 260.5H480 M0 340.5H480 M0 420.5H480 M400.5 0V600" />
    </svg>
  );
}
