FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt
COPY app ./app
CMD ["uvicorn", "app.services.gateway:app", "--host", "0.0.0.0", "--port", "8080"]
