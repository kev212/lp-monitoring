import { startBot } from './core.js'

process.on('unhandledRejection', reason => {
  console.error(`[process] unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`)
})

startBot().catch(err => {
  console.error(err)
  process.exit(1)
})
