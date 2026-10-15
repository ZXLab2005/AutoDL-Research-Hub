if test -f ~/.bashrc; then source ~/.bashrc; fi
source /root/autodl-tmp/research-hub/projects/Search-R1/repro/activate.sh searchr1
printf '\nSearch-R1 | environment: %s | project: %s\n' "$CONDA_DEFAULT_ENV" "$PWD"
