from fastapi import FastAPI
app = FastAPI(title='Backend API')
@app.get('/health')
async def health():
    return {'status': 'ok'}
