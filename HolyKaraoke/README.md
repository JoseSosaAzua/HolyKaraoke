# Holy Karaoke

Muestra automáticamente la estrofa que se está cantando, escuchando el micrófono.

## Cómo usarlo

1. Para Deepgram, copia `.env.example` como `.env` y pon tu API key.
   Para Vosk no necesitas API key; instala el motor local como se indica abajo.
2. Instala dependencias: `npm install`
3. Arranca: `npm run dev`
4. Abre http://localhost:5173, elige la canción y el motor **Deepgram (nube)**
   o **Vosk (local)** y presiona **Escuchar**.

La casilla **Seguir palabras**, activada por defecto, resalta en amarillo y subraya
la palabra de la letra que coincide con lo último reconocido. Puedes desmarcarla
durante la escucha para mantener solamente el cambio automático de diapositivas.
Funciona con ambos motores y con resultados parciales; depende de la precisión
y del retraso del reconocimiento, no de tiempos predefinidos de la canción.

## Instalar Vosk en Windows

Esta instalación es independiente de VoiceModels y no utiliza su micrófono,
entorno Python ni modelo. Ambos motores reciben el mismo audio del navegador.

Desde PowerShell:

```powershell
Set-Location C:\Dev\HolyKaraoke
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
New-Item -ItemType Directory -Path models -Force
Invoke-WebRequest -Uri "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip" -OutFile "models\vosk-model-small-es-0.42.zip"
Expand-Archive -Path "models\vosk-model-small-es-0.42.zip" -DestinationPath models
Remove-Item -LiteralPath "models\vosk-model-small-es-0.42.zip"
```

El modelo extraído debe contener las carpetas `am`, `conf` y `graph` dentro
de `models\vosk-model-small-es-0.42`. También puedes descargarlo desde la
[página oficial de Vosk](https://alphacephei.com/vosk/models).
Opcionalmente configura `VOSK_PYTHON` y `VOSK_MODEL_PATH` en `.env` con rutas
absolutas si utilizas otra ubicación.

No necesitas activar el entorno Python para `npm run dev`. El servidor inicia
un proceso de Vosk por conexión y lo termina al detener la escucha.
La captura empieza al aparecer **Escuchando con Vosk**, después de cargar el
modelo; ese tiempo de inicio no es latencia de reconocimiento. Una vez instalado,
Vosk reconoce sin internet. Los errores de instalación/modelo se muestran en la
interfaz y la consola del servidor. Si se acumulan más de cinco segundos de audio
pendiente de envío, la sesión se detiene con un error en lugar de seguir retrasándose.

## Comparar los motores

1. Prepara una grabación con varios cambios de estrofa y silencio al inicio/final.
2. Selecciona la canción y Deepgram; pulsa **Escuchar** y espera el estado
   **Escuchando con Deepgram** antes de reproducir la grabación.
3. Graba la pantalla con audio, incluyendo **Escuchado** y la diapositiva.
4. Pulsa **Detener**, selecciona Vosk y repite exactamente la misma grabación,
   con el mismo micrófono, posición y volumen. Cambiar el motor reinicia la
   estrofa y el historial. No se puede cambiar canción/motor durante la escucha.
5. Alterna tres pruebas por motor. Para repetir el mismo motor desde el comienzo,
   recarga la página y vuelve a seleccionar la canción y el motor.
6. En los videos mide, para las mismas palabras que distinguen cada nueva
   estrofa, desde el final audible de la palabra hasta su primera aparición
   correcta en **Escuchado**, y hasta el cambio de diapositiva.
   Anota también palabras no reconocidas y cambios incorrectos.

Los dos motores usan PCM mono de 16 bits, el mismo capturador de navegador,
resultados parciales y el mismo algoritmo de selección de estrofas.
Deepgram conserva sus palabras clave por canción. Vosk usa por defecto los versos
de la canción seleccionada como gramática restringida, junto con `[unk]` para
audio no reconocido. Se conservan los acentos, se quitan signos de puntuación y se
deduplican versos. Se incluyen todas las estrofas, no solamente la siguiente.
`[unk]` no cuenta como palabra para decidir el cambio de diapositiva.

Con Vosk seleccionado, desmarca **Usar letra como vocabulario** para comparar
con el reconocimiento general anterior, sin cambiar el motor ni el capturador.
Detén la escucha antes de cambiar esa opción; el cambio reinicia estrofa e historial.
La gramática se carga antes de iniciar la captura y no espera resultados finales.
Vosk sigue usando su diccionario acústico: la gramática no añade palabras nuevas.
Las palabras de la letra que no existen en el modelo generan avisos en la consola
del servidor y Vosk las ignora. Si ninguna existe, la sesión falla explícitamente.
Las canciones ausentes, mal formadas o sin palabras también producen un error,
sin volver silenciosamente al modo general.

La restricción puede mejorar la precisión, pero también forzar coincidencias
incorrectas con música o voz ajena a la letra. `[unk]` reduce esa presión, sin
garantizar que no haya errores. Compara la misma grabación con la opción activada
y desactivada, midiendo retrasos y contando cambios incorrectos.
Esta comparación evalúa las configuraciones seleccionadas.
Se eliminó el cálculo anterior basado en el último bloque enviado: no medía la
latencia real de reconocimiento. La interfaz no presenta una latencia numérica
sin una referencia fiable del final de la palabra en el audio.

## Validación

```powershell
npm run typecheck
.\.venv\Scripts\python.exe -m unittest discover -s tests
npx tsx --test tests\vosk.test.ts
```

La última prueba necesita el entorno y modelo Vosk instalados; verifica la
conexión WebSocket con audio PCM, la carga real y los errores de configuración.

Para probar solamente el seguimiento de palabras, sin cargar el modelo:

```powershell
npx tsx --test --test-name-pattern="Word tracking|Unknown markers" tests\vosk.test.ts
```

Las flechas ← → del teclado cambian de estrofa a mano si hace falta.
Pulsa F11 para pantalla completa en el proyector.

## Agregar canciones

Crea un archivo `.json` en la carpeta `songs/` con este formato
(cada estrofa es una lista de versos):

```json
{
  "titulo": "Nombre de la canción",
  "estrofas": [
    ["verso 1", "verso 2"],
    ["verso 1", "verso 2"]
  ]
}
```

## Cómo funciona

- `server/index.ts`: entrega las canciones y dirige el audio al motor seleccionado
  (la API key de Deepgram queda en el servidor).
- `server/vosk.ts` y `server/vosk_worker.py`: envían el PCM al reconocedor local
  y devuelven transcripciones parciales/finales con el mismo formato que Deepgram.
- `src/App.tsx`: la pantalla; graba el micrófono y muestra la estrofa.
- `src/matcher.ts`: compara las últimas palabras escuchadas con todas las líneas de cada estrofa.
  Cambia de estrofa cuando una palabra reciente ya no está en la estrofa actual y sí en otra
  (se puede ajustar con `MIN_WORDS`). Solo se muestra texto de la letra guardada, nunca lo que
  "inventa" el reconocimiento.
