{{- define "medusa-store.fullname" -}}
{{- default .Chart.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "medusa-store.labels" -}}
helm.sh/chart: {{ include "medusa-store.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: urumi
{{- end }}
