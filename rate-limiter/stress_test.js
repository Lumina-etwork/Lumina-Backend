const http = require('http');

const URL = 'http://localhost:3000/';
const KEYS = 100;
const REQ_PER_SEC = 10000;
const DURATION_SEC = 5;

let requestsSent = 0;
let rateLimited = 0;
let successful = 0;

async function sendRequest(key) {
    return new Promise((resolve) => {
        const req = http.get(URL, {
            headers: {
                'X-API-Key': 	est_key_
            }
        }, (res) => {
            if (res.statusCode === 429) {
                rateLimited++;
            } else if (res.statusCode === 200) {
                successful++;
            }
            res.resume();
            resolve();
        });
        
        req.on('error', () => {
            resolve();
        });
        
        req.end();
    });
}

async function run() {
    console.log(Starting stress test:  req/s for  seconds...);
    const interval = 1000 / REQ_PER_SEC;
    
    let timeStart = Date.now();
    let promises = [];
    
    let timer = setInterval(() => {
        let key = Math.floor(Math.random() * KEYS);
        promises.push(sendRequest(key));
        requestsSent++;
        
        if (Date.now() - timeStart > DURATION_SEC * 1000) {
            clearInterval(timer);
            Promise.all(promises).then(() => {
                console.log('--- Results ---');
                console.log(Requests Sent: );
                console.log(Successful: );
                console.log(Rate Limited (429): );
            });
        }
    }, interval);
}

run();
