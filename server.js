#!/usr/bin/env node
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config()
}
require('@bprcode/handy')
const { WebSocketServer } = require('ws')
const { ChatChannel, WebSocketRelay } = require('./chat-channel.cjs')
const express = require('express')
const http = require('node:http')
const path = require('node:path')

const app = express()
const wsServer = new WebSocketServer({ noServer: true })
const wsRelay = new WebSocketRelay()
const server = http.createServer(app)
const channel = new ChatChannel({ relay: wsRelay })

app
    .disable('x-powered-by')
    .use((req, res, next) => {
        log(`Got ${req.method} request for ${req.url}`, dim)
        next()
    })
    .use(express.static('public'))
    .get('/', (req, res, next) => {
        log('redirecting')
        res.redirect(process.env.HOME_PAGE)
    })
    .get('/check', (req, res) => {
        res.send('Chat server is running.')
    })
    .get('*', (req, res) => {
        res.status(404).send('Resource unavailable.')
    })

server
    .listen(process.env.PORT || 80, () => {
        if (process.env.NODE_ENV === 'production')
            log('Production Environment', blue)
        else
            log('Development Environment', pink)
        log('🚦 ' + new Date().toLocaleString() +
        ' Server started at:\n', green, server.address())
        channel.receive({
            text: moo() + ' Server started.',
            _remember: true
        })
    })
    .on('upgrade', (request, socket, head) => {
        log('Socket upgrade request received', green)
        // Use the ws library to handle handshaking.
        wsServer.handleUpgrade(request, socket, head, newSocket => {
            wsServer.emit('connection', newSocket)
        })
    })

wsServer
    .on('connection', (newSocket) => {
        // There is now a new WebSocket to welcome.
        wsRelay.receiveConnection(newSocket)
    })
