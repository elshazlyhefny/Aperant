import { memo, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskCard } from './TaskCard';
import { cn } from '../lib/utils';
import type { Task, TaskStatus } from '../../shared/types';
import type { TaskFileOverlap } from '../../shared/utils/file-overlap';

interface SortableTaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange?: (newStatus: TaskStatus) => unknown;
  // Optional selection props for multi-selection in Human Review column
  isSelectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  // Disable dragging (e.g. while a search filter is active)
  isDragDisabled?: boolean;
  // zeenha fork: overlap warning data for the card
  fileOverlaps?: TaskFileOverlap[];
  holdBlockerTitle?: string;
}

// Custom comparator - only re-render when task or onClick actually changed
function sortableTaskCardPropsAreEqual(
  prevProps: SortableTaskCardProps,
  nextProps: SortableTaskCardProps
): boolean {
  // TaskCard has its own memo, so we just need to check reference equality
  // for the task object and onClick handler
  return (
    prevProps.task === nextProps.task &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.onStatusChange === nextProps.onStatusChange &&
    prevProps.isSelectable === nextProps.isSelectable &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.onToggleSelect === nextProps.onToggleSelect &&
    prevProps.isDragDisabled === nextProps.isDragDisabled &&
    prevProps.fileOverlaps === nextProps.fileOverlaps &&
    prevProps.holdBlockerTitle === nextProps.holdBlockerTitle
  );
}

export const SortableTaskCard = memo(function SortableTaskCard({ task, onClick, onStatusChange, isSelectable, isSelected, onToggleSelect, isDragDisabled, fileOverlaps, holdBlockerTitle }: SortableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    active
  } = useSortable({
    id: task.id,
    // Prevent dragging tasks that are currently running or stuck, or when dragging is disabled
    disabled: task.status === 'in_progress' || !!isDragDisabled
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Prevent z-index stacking issues during drag
    zIndex: isDragging ? 50 : undefined
  };

  // Memoize onClick to prevent unnecessary TaskCard re-renders
  const handleClick = useCallback(() => {
    onClick();
  }, [onClick]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'touch-none transition-all duration-200 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        isDragging && 'dragging-placeholder opacity-40 scale-[0.98]',
        isOver && !isDragging && 'ring-2 ring-primary/30 ring-offset-2 ring-offset-background rounded-xl'
      )}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget && !isDragging && !e.defaultPrevented) {
          e.preventDefault();
          handleClick();
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
    >
      {/* Inner wrapper (not the dnd-kit node): content-visibility implies paint containment,
          so padding + equal negative margin keep ring-2 and hover glow from being clipped.
          Disabled during a drag so dnd-kit never measures cards whose size changes. */}
      <div className={cn(!active && 'kanban-card-offscreen-skip p-2 -m-2')}>
        <TaskCard
          task={task}
          onClick={handleClick}
          onStatusChange={onStatusChange}
          isSelectable={isSelectable}
          isSelected={isSelected}
          onToggleSelect={onToggleSelect}
          fileOverlaps={fileOverlaps}
          holdBlockerTitle={holdBlockerTitle}
        />
      </div>
    </div>
  );
}, sortableTaskCardPropsAreEqual);
