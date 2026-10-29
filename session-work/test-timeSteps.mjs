// Test: POST /data + POST /train mit timeSteps=20 gegen http://localhost:3001
const base = 'http://localhost:3001';
const data = JSON.parse(await (await import('node:fs')).promises.readFile(
  'c:/_work/_node/dataHumanLabelingAnomalyDetection/example-iot-data.json', 'utf8'));

let resp = await fetch(base + '/data', {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify(data)
});
console.log('POST /data:', resp.status);

async function train(body) {
  const r = await fetch(base + '/train', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ data, selectedIndices: [], ...body })
  });
  console.log('POST /train:', r.status);
  const result = await r.json();
  console.log('  timeSteps:', result.timeSteps, '| totalSequences:', result.totalSequences, '| threshold:', result.anomalyThreshold);
  return result;
}

console.log('\n--- Training mit timeSteps=20 ---');
await train({ timeSteps: 20 });

console.log('\n--- Training ohne timeSteps (Default) ---');
await train({});
