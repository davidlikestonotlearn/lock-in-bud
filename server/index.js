const path = require('node:path');

// Resolve from this file, so npm start:server works from the project root.
try { process.loadEnvFile(path.join(__dirname, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const { createApp } = require('./app');
const server = createApp().listen(3000, '127.0.0.1', () => {
  console.log('Lock-In Buddy analysis service: http://127.0.0.1:3000');
  if (!process.env.GROQ_API_KEY?.trim() || process.env.GROQ_API_KEY.trim() === 'your_key_here') {
    console.log('Add GROQ_API_KEY to server/.env and restart to enable AI classification.');
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? 'Port 3000 is already in use. Stop the other server and try again.' : 'Could not start the analysis service.');
  process.exitCode = 1;
});
