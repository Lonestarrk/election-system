'use client'

import { useId, useState } from 'react'

/**
 * En knapp som ber om en bekräftelse innan den gör något.
 *
 * Bekräftelsen står på sidan och är inte webbläsarens dialogruta, så att den går
 * att läsa med skärmläsare, ger fokus till bekräftelseknappen och inte stjäl
 * tangentbordet. Texten ska säga vad som händer och om det går att ångra.
 */
export function ConfirmButton(props: {
  label: string
  confirmText: string
  confirmLabel: string
  disabled: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  const textId = useId()

  if (!open) {
    return (
      <button type="button" disabled={props.disabled} onClick={() => setOpen(true)}>
        {props.label}
      </button>
    )
  }

  return (
    <div className="notice warning" role="group" aria-labelledby={textId} style={{ width: '100%' }}>
      <p id={textId} style={{ marginBottom: '0.75rem' }}>
        {props.confirmText}
      </p>
      <div className="button-row">
        <button
          type="button"
          autoFocus
          disabled={props.disabled}
          onClick={() => {
            setOpen(false)
            props.onConfirm()
          }}
        >
          {props.confirmLabel}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Avbryt
        </button>
      </div>
    </div>
  )
}
