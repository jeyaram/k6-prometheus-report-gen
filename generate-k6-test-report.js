import http from 'k6/http';
import { check, sleep } from 'k6';
import { encoding } from 'k6/encoding';
import { readFileSync } from 'fs';

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

function saveResultsToMinio(filename, content) {
    const url = `${minioUrl}/${minioBucket}/${filename}`;

    // Encode the access key and secret key in base64
    const credentials = `${minioAccessKey}:${minioSecretKey}`;
    const encodedCredentials = encoding.b64encode(credentials);

    const headers = {
        'Content-Type': 'text/plain',
        'Authorization': `Basic ${encodedCredentials}`,
    };

    const res = http.put(url, content, { headers: headers });
    check(res, { 'Uploaded results to MinIO': (r) => r.status === 200 });
}

// Function to wait for the completion and cleanup of a TestRun
function waitForTestRunCompletion() {
    const url = `${k8sApiUrl}/apis/k6.io/v1alpha1/namespaces/${targetNamespace}/testruns/${targetTestRunName}`;
    const headers = {
        'Authorization': `Bearer ${bearerToken}`,
        'Accept': 'application/json',
    };

    while (true) {
        const res = http.get(url, {
            headers: headers,
            timeout: 60000, // 60 seconds timeout for the request
            responseType: 'text',
            tags: { name: 'GetTestRunStatus' },
            tlsAuth: [{ cert: '', key: '' }],
            tlsCaCerts: [caCert],  // Use the CA cert from the service account
            maxRedirects: 0
        });

        if (res.status === 404) {
            console.log(`TestRun "${targetTestRunName}" has been cleaned up and no longer exists.`);
            break;
        } else if (res.status !== 200) {
            console.error(`Failed to get the status of the TestRun "${targetTestRunName}". Status: ${res.status}`);
            break;
        }

        const responseBody = JSON.parse(res.body);
        const status = responseBody.status.phase;

        console.log(`Waiting for TestRun "${targetTestRunName}" to complete and be cleaned up... Current status: ${status}`);
        sleep(10);  // Poll every 10 seconds
    }
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
