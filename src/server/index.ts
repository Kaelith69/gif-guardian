#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
import {createServer, getServerPort} from '@devvit/server'
import {onReq} from './server.ts'

const server = createServer(onReq)
const port: number = getServerPort()

server.on('error', err => console.error(`server error; ${err.stack}`))
server.listen(port, () => console.log(`http://localhost:${port}`))
