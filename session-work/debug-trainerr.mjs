import fs from 'node:fs';
const root = process.argv[2];
const data = JSON.parse(fs.readFileSync(`${root}/example-iot-data.json`,'utf8'));
let maxV=-1,idx=-1;
data.forEach((r,i)=>{const v=r.values?.bearing_temp_c; if(v&&typeof v==='object'&&v.value>maxV){maxV=v.value;idx=i;}});
data[idx].values.bearing_temp_c.humanLabel='anomaly';
const res = await fetch('http://localhost:3000/train',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data,selectedIndices:[idx],timeSteps:10})});
const t = await res.json();
console.log('TRAIN ERROR:', t.error);
