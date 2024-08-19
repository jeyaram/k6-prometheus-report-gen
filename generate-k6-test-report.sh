#!/bin/bash

# Arguments
PROMETHEUS_URL=$1
TESTID=$2
DURATION_HOURS=$3

# Calculate start and end time in Prometheus-compatible format
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_TIME=$(date -u -d "$DURATION_HOURS hours ago" +"%Y-%m-%dT%H:%M:%SZ")

# Function to query Prometheus
query_prometheus() {
    local query=$1
    curl -sG --data-urlencode "query=$query" --data-urlencode "start=$START_TIME" --data-urlencode "end=$END_TIME" --data-urlencode "step=1m" "$PROMETHEUS_URL/api/v1/query_range"
}

# Query metrics
HTTP_REQS_TOTAL=$(query_prometheus "sum(k6_http_reqs_total{testid='$TESTID'})" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s}')
REQUESTS_PER_SECOND=$(query_prometheus "sum(irate(k6_http_reqs_total{testid='$TESTID'}[1m]))" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s/NR}')
HTTP_REQ_DURATION_AVG=$(query_prometheus "histogram_sum(k6_http_req_duration_seconds{testid='$TESTID'}) / histogram_count(k6_http_req_duration_seconds{testid='$TESTID'})" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s/NR}')
HTTP_REQ_DURATION_MIN=$(query_prometheus "histogram_quantile(0.0, rate(k6_http_req_duration_seconds{testid='$TESTID'}[1m]))" | jq -r '.data.result[0].values[] | .[1]' | awk 'NR==1 {min=$1} $1<min {min=$1} END {print min}')
HTTP_REQ_DURATION_MAX=$(query_prometheus "histogram_quantile(1.0, rate(k6_http_req_duration_seconds{testid='$TESTID'}[1m]))" | jq -r '.data.result[0].values[] | .[1]' | awk 'NR==1 {max=$1} $1>max {max=$1} END {print max}')
HTTP_REQ_DURATION_90TH=$(query_prometheus "histogram_quantile(0.90, sum(rate(k6_http_req_duration_seconds{testid='$TESTID'}[1m])) by (le))" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s/NR}')
HTTP_REQ_DURATION_95TH=$(query_prometheus "histogram_quantile(0.95, sum(rate(k6_http_req_duration_seconds{testid='$TESTID'}[1m])) by (le))" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s/NR}')
HTTP_REQ_DURATION_99TH=$(query_prometheus "histogram_quantile(0.99, sum(rate(k6_http_req_duration_seconds{testid='$TESTID'}[1m])) by (le))" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s/NR}')
VUS_MAX=$(query_prometheus "max(k6_vus{testid='$TESTID'})" | jq -r '.data.result[0].values[] | .[1]' | awk '{print $1}')
ITERATIONS_TOTAL=$(query_prometheus "sum(k6_iterations_total{testid='$TESTID'})" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s}')
REQUEST_FAILURES=$(query_prometheus "sum(k6_http_reqs_total{testid='$TESTID', expected_response='false'})" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s}')
CHECKS_SUCCESS_RATE=$(query_prometheus "round(k6_checks_rate{testid='$TESTID'} * 100, 0.1)" | jq -r '.data.result[0].values[] | .[1]' | awk '{s+=$1} END {print s/NR}')

# Format the summary report
SUMMARY_REPORT=$(cat <<EOF
k6 Test Summary for Test ID: $TESTID

http_reqs_total..............: ${HTTP_REQS_TOTAL:-N/A}
requests_per_second..........: ${REQUESTS_PER_SECOND:-N/A}
http_req_duration_avg........: ${HTTP_REQ_DURATION_AVG:-N/A}
http_req_duration_min........: ${HTTP_REQ_DURATION_MIN:-N/A}
http_req_duration_max........: ${HTTP_REQ_DURATION_MAX:-N/A}
http_req_duration_90th.......: ${HTTP_REQ_DURATION_90TH:-N/A}
http_req_duration_95th.......: ${HTTP_REQ_DURATION_95TH:-N/A}
http_req_duration_99th.......: ${HTTP_REQ_DURATION_99TH:-N/A}
vus_max......................: ${VUS_MAX:-N/A}
iterations_total.............: ${ITERATIONS_TOTAL:-N/A}
request_failures.............: ${REQUEST_FAILURES:-N/A}
checks_success_rate..........: ${CHECKS_SUCCESS_RATE:-N/A}
EOF
)

# Write the summary report to a text file
echo "$SUMMARY_REPORT" > "${TESTID}.txt"
echo "Summary report saved to ${TESTID}.txt"
