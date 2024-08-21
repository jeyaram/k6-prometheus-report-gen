import http from 'k6/http';
import { check, sleep } from 'k6';
import { readFileSync } from 'fs';
import { encoding, hmac } from 'k6/crypto';

// Environment variables
const prometheusUrl = __ENV.PROMETHEUS_URL;
const testid = __ENV.TESTID;
const durationHours = __ENV.DURATION_HOURS || 1;
const minioUrl = __ENV.MINIO_URL;
const minioBucket = __ENV.MINIO_BUCKET;
const minioAccessKey = __ENV.MINIO_ACCESS_KEY;
const minioSecretKey = __ENV.MINIO_SECRET_KEY;
const targetTestRunName = __ENV.TARGET_TEST_RUN_NAME;

const k8sApiUrl = 'https://kubernetes.default.svc';
const bearerToken = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
const targetNamespace = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
const caCert = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');

const endTime = new Date().toISOString();
const startTime = new Date(Date.now() - durationHours * 60 * 60 * 1000).toISOString();
const step = '1m';

function queryPrometheus(query) {
    const url = `${prometheusUrl}/api/v1/query_range`;
    const params = {
        query: query,
        start: startTime,
        end: endTime,
        step: step,
    };
    const res = http.get(url, { params: params });
    check(res, { 'Prometheus query successful': (r) => r.status === 200 });
    return JSON.parse(res.body).data.result[0]?.values.map(v => parseFloat(v[1])) || [];
}

// Function to convert hex to binary
function hexToBinary(hex) {
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
        bytes.push(String.fromCharCode(parseInt(hex.substr(i, 2), 16)));
    }
    return bytes.join('');
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
    const kDate = hmac('sha256', 'AWS4' + key, dateStamp, 'hex');
    const kRegion = hmac('sha256', hexToBinary(kDate), regionName, 'hex');
    const kService = hmac('sha256', hexToBinary(kRegion), serviceName, 'hex');
    const kSigning = hmac('sha256', hexToBinary(kService), 'aws4_request', 'hex');
    return hexToBinary(kSigning);
}

function saveResultsToMinio(filename, content) {
    const method = 'PUT';
    const service = 's3';
    const region = 'us-east-1'; // MinIO typically ignores the region, but AWS4 requires one
    const host = `${__ENV.MINIO_URL.replace('http://', '').replace('https://', '')}`;
    const endpoint = `/${__ENV.MINIO_BUCKET}/${filename}`;
    const accessKey = __ENV.MINIO_ACCESS_KEY;
    const secretKey = __ENV.MINIO_SECRET_KEY;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDD'T'HHMMSS'Z'
    const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

    const payloadHash = encoding.hexEncode(encoding.sha256(content || ''));
    const canonicalUri = endpoint;
    const canonicalQuerystring = '';
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${encoding.hexEncode(encoding.sha256(canonicalRequest))}`;

    const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
    const signature = encoding.hexEncode(hmac('sha256', signingKey, stringToSign, 'hex'));

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
        'Authorization': authorizationHeader,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Content-Type': 'text/plain',
    };

    const url = `${__ENV.MINIO_URL}${canonicalUri}`;
    const res = http.put(url, content, { headers: headers });

    check(res, { 'Uploaded results to MinIO': (r) => r.status === 200 });
}

// Main function
export default function () {
    // Wait for the target TestRun to complete and be cleaned up
    waitForTestRunCompletion();

    // Generate the summary report after the target TestRun completes and is cleaned up
    const httpReqsTotal = queryPrometheus(`sum(k6_http_reqs_total{testid="${testid}"})`).reduce((a, b) => a + b, 0);
    const requestsPerSecond = queryPrometheus(`sum(irate(k6_http_reqs_total{testid="${testid}"}[1m]))`).reduce((a, b) => a + b, 0);
    const httpReqDurationAvg = queryPrometheus(`histogram_sum(k6_http_req_duration_seconds{testid="${testid}"}) / histogram_count(k6_http_req_duration_seconds{testid="${testid}"})`).reduce((a, b) => a + b, 0);
    const httpReqDurationMin = Math.min(...queryPrometheus(`histogram_quantile(0.0, rate(k6_http_req_duration_seconds{testid="${testid}"}[1m]))`));
    const httpReqDurationMax = Math.max(...queryPrometheus(`histogram_quantile(1.0, rate(k6_http_req_duration_seconds{testid="${testid}"}[1m]))`));
    const httpReqDuration90th = queryPrometheus(`histogram_quantile(0.90, sum(rate(k6_http_req_duration_seconds{testid="${testid}"}[1m])) by (le))`).reduce((a, b) => a + b, 0);
    const httpReqDuration95th = queryPrometheus(`histogram_quantile(0.95, sum(rate(k6_http_req_duration_seconds{testid="${testid}"}[1m])) by (le))`).reduce((a, b) => a + b, 0);
    const httpReqDuration99th = queryPrometheus(`histogram_quantile(0.99, sum(rate(k6_http_req_duration_seconds{testid="${testid}"}[1m])) by (le))`).reduce((a, b) => a + b, 0);
    const vusMax = Math.max(...queryPrometheus(`max(k6_vus{testid="${testid}"})`));
    const iterationsTotal = queryPrometheus(`sum(k6_iterations_total{testid="${testid}"})`).reduce((a, b) => a + b, 0);
    const requestFailures = queryPrometheus(`sum(k6_http_reqs_total{testid="${testid}", expected_response="false"})`).reduce((a, b) => a + b, 0);
    const checksSuccessRate = queryPrometheus(`round(k6_checks_rate{testid="${testid}"} * 100, 0.1)`).reduce((a, b) => a + b, 0);

    const summaryContent = `
k6 Test Summary for Test ID: ${testid}

http_reqs_total..............: ${httpReqsTotal}
requests_per_second..........: ${requestsPerSecond}
http_req_duration_avg........: ${httpReqDurationAvg}
http_req_duration_min........: ${httpReqDurationMin}
http_req_duration_max........: ${httpReqDurationMax}
http_req_duration_90th.......: ${httpReqDuration90th}
http_req_duration_95th.......: ${httpReqDuration95th}
http_req_duration_99th.......: ${httpReqDuration99th}
vus_max......................: ${vusMax}
iterations_total.............: ${iterationsTotal}
request_failures.............: ${requestFailures}
checks_success_rate..........: ${checksSuccessRate}%
`;

    console.log(summaryContent);

    saveResultsToMinio(`${testid}-summary.txt`, summaryContent);

    sleep(1);
}
