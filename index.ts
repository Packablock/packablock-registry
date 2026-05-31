#!/usr/bin/env bun
import { startServer } from './src/server.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
startServer(PORT);