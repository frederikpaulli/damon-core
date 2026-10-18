export const SMALL_FIX_CALLER = 'damon:small-fix'
export const SMALL_FIX_REVIEWER = 'code:small-fix'
export const SMALL_FIX_TASK_PREFIX = 'small-fix:'
export const isSmallFixTask = (taskId: string): boolean => taskId.startsWith(SMALL_FIX_TASK_PREFIX)
