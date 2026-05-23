import { startBot } from './core.js'

startBot().catch(err => {
  console.error(err)
  process.exit(1)
})
