import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from 'react'

import { DASHBOARD_COLUMNS, type WidgetId, type WidgetItem } from './layout.js'

export type WidgetFrameProps = {
  item: WidgetItem
  title: ReactNode
  action?: ReactNode
  children: ReactNode
  onResize: (next: { w: number; h: number }) => void
}

const MIN_W = 3
const MIN_H = 1
const MAX_H = 3

/**
 * A sortable widget card. The drag handle is the header chip; the body hosts
 * the widget content. The SE-corner resize handle directly updates `w`/`h` in
 * column-snap units derived from the parent grid width.
 */
export function WidgetFrame(props: WidgetFrameProps) {
  const { item, title, action, children, onResize } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })

  const cardRef = useRef<HTMLElement | null>(null)
  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      cardRef.current = node
      setNodeRef(node)
    },
    [setNodeRef],
  )

  const style: CSSProperties = {
    ['--w' as never]: item.w,
    ['--h' as never]: item.h,
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const [resizing, setResizing] = useState(false)
  const resizeStateRef = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
    cellWidth: number
    cellHeight: number
  } | null>(null)

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      event.preventDefault()
      const card = cardRef.current
      if (!card) return
      const grid = card.parentElement
      if (!grid) return
      const gridRect = grid.getBoundingClientRect()
      const gridStyle = window.getComputedStyle(grid)
      const gap = Number.parseFloat(gridStyle.columnGap || gridStyle.gap || '0') || 0
      const cellWidth = (gridRect.width - gap * (DASHBOARD_COLUMNS - 1)) / DASHBOARD_COLUMNS
      const rowGap = Number.parseFloat(gridStyle.rowGap || gridStyle.gap || '0') || 0
      const cardRect = card.getBoundingClientRect()
      const cellHeight = (cardRect.height + rowGap) / item.h
      resizeStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startW: item.w,
        startH: item.h,
        cellWidth,
        cellHeight,
      }
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
      setResizing(true)
    },
    [item.h, item.w],
  )

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const state = resizeStateRef.current
      if (!state) return
      const deltaW = Math.round((event.clientX - state.startX) / state.cellWidth)
      const deltaH = Math.round((event.clientY - state.startY) / state.cellHeight)
      const nextW = clamp(state.startW + deltaW, MIN_W, DASHBOARD_COLUMNS)
      const nextH = clamp(state.startH + deltaH, MIN_H, MAX_H)
      if (nextW !== item.w || nextH !== item.h) {
        onResize({ w: nextW, h: nextH })
      }
    },
    [item.h, item.w, onResize],
  )

  const handleResizePointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    resizeStateRef.current = null
    setResizing(false)
    try {
      ;(event.target as HTMLElement).releasePointerCapture(event.pointerId)
    } catch {
      // ignore: pointer may already be released when capture was lost
    }
  }, [])

  return (
    <section
      ref={setRefs}
      className="dashboard-widget"
      data-dragging={isDragging || undefined}
      data-resizing={resizing || undefined}
      data-widget-id={item.id satisfies WidgetId}
      style={style}
    >
      <header className="dashboard-widget-header">
        <button
          type="button"
          className="dashboard-widget-handle"
          aria-label={`Move ${item.id}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} aria-hidden /> <span>{title}</span>
        </button>
        {action ? <div>{action}</div> : null}
      </header>
      <div className="dashboard-widget-body">{children}</div>
      <button
        type="button"
        className="dashboard-widget-resize"
        aria-label="Resize widget"
        tabIndex={-1}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      />
    </section>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
