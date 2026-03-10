require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`FinMolt API server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});
