// Invented sample data for the preview page. The project, people and
// addresses are made up; nothing here comes from a real project.
import type { YourTurnItem } from '../../shared/your-turn'
import type { TaskInfo } from '../../shared/types'

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

export const PROJECT_ID = 'demo-bakery'

export const ITEMS: YourTurnItem[] = [
  {
    id: 'card-send-1',
    kind: 'send',
    title: 'Reply to the flour supplier about the new delivery day',
    what: 'What needs you: the reply goes out from your own email account.\nWhy: the supplier asked to move deliveries from Monday to Tuesday, and the team agreed it fits the baking plan.\nWhat to do: read the words, then press Send or copy them and send them yourself.',
    text: 'Hello Anna,\n\nTuesday mornings work well for us from next week. Please keep the same order size for now; we will review it at the end of the month.\n\nBest regards,\nThe Harbour Lane Bakery',
    to: { name: 'Anna (Millstone Flour)', contact: 'orders@millstone.example' },
    by: 'Supplier lead',
    at: at(42),
    raisedAt: at(42)
  },
  {
    id: 'card-submit-1',
    kind: 'submit',
    title: 'Submit the market stall booking form',
    what: 'What needs you: the form goes in under your name.\nWhy: the summer market closes stall bookings on Friday.\nWhat to do: press Fill it in. Damon fills the form in the team’s browser and stops before the site’s own Submit button.',
    url: 'https://market.example/stalls/book',
    files: ['outgoing/summer-market/answers.md', 'outgoing/summer-market/stall-plan.pdf'],
    by: 'Events lead',
    at: at(180),
    raisedAt: at(180)
  },
  {
    id: 'card-decide-1',
    kind: 'decide',
    title: 'The reviewer objected to the price list',
    what: 'What needs you: a choice between the builder and the reviewer.\nWhy: the reviewer says two prices on the new list do not match the costing sheet. The builder says the costing sheet is out of date.\nDamon’s reason: the costing sheet was last changed in March, before the flour price rose.\nWhat to do: open the file and read both sides, then choose.',
    file: 'menu/price-list.md',
    sendBack: 'Rework the price list so every price matches the current costing sheet.',
    taskId: 'task-price-list',
    by: 'Reviewer',
    at: at(300),
    raisedAt: at(300)
  },
  {
    id: 'card-check-1',
    kind: 'check',
    title: 'Let the team run the site’s own tests',
    what: 'What needs you: a yes or a no.\nWhy: the website project has a test command. Reviewers can only read the code until you allow it.\nWhat to do: Allow lets them run exactly this command in a throwaway copy, never in your folder.',
    projectCheck: { name: 'site-tests', command: 'npm test' },
    by: 'Damon',
    at: at(1500),
    raisedAt: at(1500)
  }
]

export const TASKS: TaskInfo[] = []
