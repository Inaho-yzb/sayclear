import { useEffect, useLayoutEffect, useRef } from 'react'
import { Sparkles } from 'lucide-react'

type Props = {
  x: number
  y: number
  onAddToAI: () => void
  onClose: () => void
  returnFocus: () => void
}

export function DiagramContextMenu({ x, y, onAddToAI, onClose, returnFocus }: Props) {
  const menu = useRef<HTMLDivElement>(null)
  const item = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const element = menu.current!
    const bounds = element.getBoundingClientRect()
    const inset = 8
    element.style.left = `${Math.max(inset, Math.min(x, window.innerWidth - bounds.width - inset))}px`
    element.style.top = `${Math.max(inset, Math.min(y, window.innerHeight - bounds.height - inset))}px`
    item.current?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    const dismiss = () => onClose()
    document.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [onClose])

  return (
    <div
      ref={menu}
      className="diagram-context-menu"
      role="menu"
      aria-label="画板对象菜单"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          returnFocus()
        } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          item.current?.focus()
        }
      }}
    >
      <button ref={item} type="button" role="menuitem" onClick={onAddToAI}>
        <Sparkles size={15} />
        加入 AI 对话
      </button>
    </div>
  )
}
