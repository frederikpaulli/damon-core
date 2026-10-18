import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { ANSWER_MARGIN_MS, BROKER_CALL_TIMEOUT_MS, CHECK_ANSWER_MS, CHECK_MAX_MS, ISOLATED_ANSWER_MS, ISOLATED_MAX_MS, LOOK_ANSWER_MS, LOOK_TOTAL_MS, TOOL_ANSWER_MS } from '../src/shared/broker-call-limits'
import { brokerMcpConfig } from '../src/main/lib/providers/native-subscription-runtime'
import { ScopedToolBroker } from '../src/main/lib/scoped-tool-broker'

const auth = 'Bearer ' + 'a'.repeat(64)

it('the broker entry tells the program to wait longer than any Damon tool runs', () => {
  const config = JSON.parse(brokerMcpConfig('http://127.0.0.1:5000/mcp', auth))
  expect(Object.keys(config.mcpServers)).toEqual(['damon_broker'])
  expect(config.mcpServers.damon_broker).toEqual({ type: 'http', url: 'http://127.0.0.1:5000/mcp', headers: { Authorization: auth }, timeout: 930_000 })
})

it('the launch hands the program that entry and nothing else', () => {
  const src = readFileSync('src/main/lib/providers/native-subscription-runtime.ts', 'utf8')
  expect(src).toContain("'--strict-mcp-config', '--mcp-config', brokerMcpConfig(url.href, input.endpoint.headers.Authorization),")
  expect(src).not.toContain("JSON.stringify({ mcpServers: { damon_broker: { type: 'http', url: url.href")
})
