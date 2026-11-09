# Transcripción local con Vosk

Aplicación inicial de consola para transcribir desde el micrófono en tiempo real. Vosk reconoce el audio en este equipo; una vez instalado el modelo, la transcripción funciona sin conexión.

## Requisitos

- Windows y Python 3.9 o posterior.
- Micrófono configurado en Windows.

## Instalación

Desde PowerShell, en la carpeta del proyecto:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Descarga el modelo pequeño de español desde la [página oficial de modelos de Vosk](https://alphacephei.com/vosk/models) (archivo `vosk-model-small-es-0.42.zip`) y extrae la carpeta del modelo en:

```text
models\vosk-model-small-es-0.42
```

La carpeta indicada debe contener, entre otros, `am`, `conf` y `graph`.

## Uso

```powershell
python main.py
```

El programa muestra texto parcial mientras hablas y confirma cada segmento reconocido. Pulsa `Ctrl+C` para finalizar.

### Métricas de transcripción

Las métricas se muestran automáticamente en consola:

- **Inicio:** tiempo de carga del modelo e inicialización del reconocedor.
- **Mientras hablas:** `[Parcial]` muestra el texto solo cuando cambia,
  en una línea nueva para que no se sobrescriba. No se imprimen bloques.
- **Por palabra (al confirmar la frase):** tiempo estimado desde el final
  de la palabra en el audio hasta su primera aparición en consola.
  Se registra el reloj justo después de imprimir y vaciar la salida.
  La etiqueta `parcial` indica que apareció mientras hablabas; `final`
  indica que solo se pudo identificar con seguridad al confirmar.
  Esta es la métrica para comparar con el retraso al ver palabras en Deepgram,
  usando el mismo criterio de inicio (fin de palabra) en ambos sistemas.
- **Por frase confirmada:** duración desde el inicio de la primera palabra
  hasta el final de la última, y latencia estimada desde el final de la última
  palabra hasta imprimir la transcripción confirmada. Incluye el silencio que
  Vosk espera para cerrar la frase y las esperas de captura/cola.
- **Al terminar:** bloques, audio procesado, tiempo total y promedio de
  procesamiento por bloque y RTF global. El procesamiento de `FinalResult`
  se muestra por separado y no se incluye en estos totales.
  También se muestra el promedio y máximo de las latencias de palabras medidas.
  RTF = tiempo de procesamiento / duración del audio; menos de 1 significa
  que el procesamiento es más rápido que la duración del audio.

La latencia combina las marcas de palabras de Vosk con el reloj de captura
de PortAudio; es una estimación, no una medición exacta del fin de la voz.
Si se notifica un estado de audio (por ejemplo, `input overflow`), se desactivan
las nuevas latencias durante esa ejecución y se informa explícitamente;
la transcripción continúa. Al pulsar `Ctrl+C`, la frase pendiente se etiqueta
como cierre manual, no como confirmación automática; no incluye audio aún
sin procesar en la cola. Si faltan marcas de tiempo, se informa explícitamente.

Las marcas finales de Vosk se usan retrospectivamente para medir los parciales.
Si Vosk corrige palabras, se conserva la primera aparición solo del prefijo
que sigue coincidiendo; el sufijo corregido recibe un nuevo instante.
Si la primera aparición precede al fin de palabra estimado por Vosk, se informa
que la medición no está disponible en vez de mostrar una latencia negativa.
La medición llega hasta la escritura en consola, no hasta el renderizado físico
de la pantalla. No es una medición acústica externa exacta.

Estas métricas miden reconocimiento de voz, no comprensión del significado.
El tiempo de impresión no se incluye en el procesamiento medido.

Para ver los micrófonos disponibles:

```powershell
python main.py --list-devices
```

Para seleccionar uno por índice:

```powershell
python main.py --device 1
```

También se puede indicar otra carpeta de modelo con `--model`.

El programa usa la frecuencia nativa del micrófono y se la indica a Vosk.
Abre el dispositivo antes de cargar el modelo y empieza a capturar audio
solo cuando Vosk está listo. El dispositivo se cierra también si la carga falla.

### Si Windows no permite abrir el micrófono

Si aparece `Unanticipated host error` con un dispositivo MME, consulta
`--list-devices` y selecciona la entrada del mismo micrófono que use
Windows WASAPI o Windows DirectSound. Por ejemplo, si sus índices son 12 y 6:

```powershell
python main.py --device 12
# Alternativa:
python main.py --device 6
```

Los índices pueden cambiar. Comprueba que la entrada elegida tenga canales
`in`, no solo `out`. En Configuración de Windows, revisa que el acceso al
micrófono esté permitido para aplicaciones de escritorio.

Si la ejecución directa falla, pero las pruebas de apertura desde `python -c`
funcionan, se puede ejecutar la misma aplicación de esta forma:

```powershell
python -c "import main; raise SystemExit(main.main())" --device 12
```

Esta forma de ejecución se verificó con transcripción desde el micrófono.
La causa de la diferencia con `python main.py` todavía no está identificada.

Para ejecutar las pruebas sin capturar audio:

```powershell
python -m unittest discover -s tests
```
