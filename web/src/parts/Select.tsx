import { useId } from 'react';

/** A labelled choice from a short list, in the same dress as a Field. */
export function Select(props: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="ol-field">
      <label className="ol-field__label" htmlFor={id}>{props.label}</label>
      <select id={id} className="ol-field__input ol-select" value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
