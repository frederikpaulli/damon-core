// Once the protected route is on, host execution is refused. Commands go to the isolated
// worker instead.
let protectedHost = false
export function protectHostExecution(): void { protectedHost = true }
export function isHostExecutionProtected(): boolean { return protectedHost }
export function assertHostExecutionAllowed(route = 'This operation'): void {
  if (protectedHost) throw new Error(`${route} is held during the isolated execution migration. Its reviewed broker route must be ready before it can resume. No unrestricted host fallback is allowed.`)
}
