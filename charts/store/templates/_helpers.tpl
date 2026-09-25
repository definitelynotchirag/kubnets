{{/*
Expand the name of the chart.
*/}}
{{- define "urumi-store.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "urumi-store.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "urumi-store.labels" -}}
helm.sh/chart: {{ include "urumi-store.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{/*
Name of the WordPress workload created by the Bitnami subchart. Bitnami collapses
"<release>-<chart>" to just "<release>" when the release name already contains the chart
name, so this mirrors that rule exactly and cannot drift silently.
*/}}
{{- define "urumi-store.wordpressFullname" -}}
{{- if .Values.wordpress.fullnameOverride -}}
{{- .Values.wordpress.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.wordpress.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.wordpress.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains "wordpress" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-wordpress" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{/*
Name of the MariaDB Service created by the `wordpress.mariadb` subchart. Same collapse rule,
but the chart name in play is "mariadb", so the Service is "<release>-mariadb".
*/}}
{{- define "urumi-store.mariadbFullname" -}}
{{- if .Values.wordpress.mariadb.fullnameOverride -}}
{{- .Values.wordpress.mariadb.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if .Values.wordpress.mariadb.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.wordpress.mariadb.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains "mariadb" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-mariadb" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}
